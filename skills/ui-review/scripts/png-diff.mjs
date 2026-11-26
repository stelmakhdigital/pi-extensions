/**
 * Побитовое сравнение двух PNG без внешних зависимостей: декодер, энкодер и diff.
 *
 * Нужен именно свой, потому что скрипт запускается из каталога проверяемого проекта,
 * и вешать туда pixelmatch + pngjs только ради одной проверки — навязывать чужому
 * проекту две зависимости. Node умеет inflate/deflate сам, PNG разбирается за сотню строк.
 *
 * Поддержка: 8 бит, без interlace, цвет 0 (gray), 2 (RGB — такой пишет playwright)
 * и 6 (RGBA). Остальное (палитра, 16 бит, Adam7) — ошибка, и её печатает как причину,
 * а не молча сравнивает хеши.
 */
import { deflateSync, inflateSync } from "node:zlib";

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = { 0: 1, 2: 3, 6: 4 };

const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

/** Экспортируется только ради тестов: сборка служебных чанков PNG. */
export function crc32(buffer) {
	let c = 0 ^ -1;
	for (const byte of buffer) c = (c >>> 8) ^ CRC_TABLE[(c ^ byte) & 0xff];
	return (c ^ -1) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

/** Разбирает PNG в RGBA-буфер (width * height * 4). */
export function decodePng(buffer) {
	if (!buffer.subarray(0, 8).equals(SIGNATURE)) throw new Error("это не PNG");
	let width = 0;
	let height = 0;
	let depth = 0;
	let color = -1;
	let interlace = 0;
	const idat = [];
	for (let pos = 8; pos + 8 <= buffer.length; ) {
		const length = buffer.readUInt32BE(pos);
		const type = buffer.toString("ascii", pos + 4, pos + 8);
		const body = buffer.subarray(pos + 8, pos + 8 + length);
		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			depth = body[8];
			color = body[9];
			interlace = body[12];
		} else if (type === "IDAT") idat.push(body);
		else if (type === "IEND") break;
		pos += 12 + length;
	}
	const channels = CHANNELS[color];
	if (!channels || depth !== 8 || interlace !== 0) {
		throw new Error(`PNG не поддерживается: depth=${depth}, color=${color}, interlace=${interlace}`);
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = width * channels;
	const rgba = Buffer.alloc(width * height * 4);
	const previous = Buffer.alloc(stride);
	let offset = 0;

	for (let y = 0; y < height; y++) {
		const filter = raw[offset++];
		const line = Buffer.from(raw.subarray(offset, offset + stride));
		offset += stride;
		switch (filter) {
			case 0:
				break;
			case 1: // Sub: слева на bpp байт
				for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff;
				break;
			case 2: // Up: сверху
				for (let i = 0; i < stride; i++) line[i] = (line[i] + previous[i]) & 0xff;
				break;
			case 3: // Average
				for (let i = 0; i < stride; i++) {
					const left = i >= channels ? line[i - channels] : 0;
					line[i] = (line[i] + ((left + previous[i]) >> 1)) & 0xff;
				}
				break;
			case 4: // Paeth
				for (let i = 0; i < stride; i++) {
					const a = i >= channels ? line[i - channels] : 0;
					const b = previous[i];
					const c = i >= channels ? previous[i - channels] : 0;
					const p = a + b - c;
					const pa = Math.abs(p - a);
					const pb = Math.abs(p - b);
					const pc = Math.abs(p - c);
					line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
				}
				break;
			default:
				throw new Error(`неизвестный фильтр строки: ${filter}`);
		}

		for (let x = 0; x < width; x++) {
			const src = x * channels;
			const dst = (y * width + x) * 4;
			if (channels === 1) {
				rgba[dst] = rgba[dst + 1] = rgba[dst + 2] = line[src];
				rgba[dst + 3] = 255;
			} else {
				rgba[dst] = line[src];
				rgba[dst + 1] = line[src + 1];
				rgba[dst + 2] = line[src + 2];
				rgba[dst + 3] = channels === 4 ? line[src + 3] : 255;
			}
		}
		line.copy(previous);
	}
	return { width, height, data: rgba };
}

/** Собирает PNG (RGBA, 8 бит, фильтр None) из { width, height, data }. */
export function encodePng({ width, height, data }) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // depth
	ihdr[9] = 6; // color: RGBA
	const raw = Buffer.alloc(height * (1 + width * 4));
	for (let y = 0; y < height; y++) {
		const rowStart = y * (1 + width * 4);
		raw[rowStart] = 0;
		data.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
	}
	return Buffer.concat([
		SIGNATURE,
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 6 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * Сравнение двух кадров: меняющиеся пиксели закрашиваются красным, остальные —
 * затемнённое серое из "after". Отличаются размеры — diff невозможен, и это
 * само по себе находка (поменялась высота документа или ширина вьюпорта).
 */
export function diffImages(before, after, tolerance = 0.12) {
	if (before.width !== after.width || before.height !== after.height) {
		return {
			sizeDiff: `${before.width}x${before.height} против ${after.width}x${after.height}`,
			changed: 0,
			total: 0,
			image: null,
		};
	}
	const out = Buffer.alloc(after.data.length);
	let changed = 0;
	for (let i = 0; i < after.data.length; i += 4) {
		const dr = Math.abs(before.data[i] - after.data[i]);
		const dg = Math.abs(before.data[i + 1] - after.data[i + 1]);
		const db = Math.abs(before.data[i + 2] - after.data[i + 2]);
		const delta = Math.max(dr, dg, db) / 255;
		if (delta > tolerance) {
			changed++;
			out[i] = 255;
			out[i + 1] = 0;
			out[i + 2] = 0;
			out[i + 3] = 255;
			continue;
		}
		const luma = 0.299 * after.data[i] + 0.587 * after.data[i + 1] + 0.114 * after.data[i + 2];
		const faded = Math.round(255 - 0.4 * (255 - luma));
		out[i] = out[i + 1] = out[i + 2] = faded;
		out[i + 3] = 255;
	}
	return { sizeDiff: null, changed, total: after.data.length / 4, image: { width: after.width, height: after.height, data: out } };
}
