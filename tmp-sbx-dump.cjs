const fs=require("fs"),os=require("os"),path=require("path");
const jiti=require("jiti")(path.resolve(__filename));
const src=fs.readFileSync("./extensions/sandbox/index.ts","utf8");
// вырежем sbplProfile руками проще: соберём профиль тем же кодом через импорт невозмно (function internal), воспроизведём вручную
const home=os.homedir(), fx=path.join(home,"pi-sbx-probe");
fs.mkdirSync(fx,{recursive:true});
const fakeHome=fs.mkdtempSync(path.join(os.tmpdir(),"pi-sandbox-home-"));
const deny=[".pi",".ssh",".aws",".gnupg",".config"].map(p=>`(literal "${path.join(home,p)}")`).join(" ");
const prof=["(version 1)","(deny default)",
"(allow process-fork)","(allow process-exec*)","(allow signal (target same-sandbox))",
"(allow file-map-executable)","(allow sysctl-read)",
'(allow file-read* (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System") (subpath "/Library") (subpath "/private/var/db"))',
`(allow file-read* (literal "${fakeHome}"))`,
`(allow file-read* file-write* (subpath "${fx}"))`,
'(allow file-read* file-write* (subpath "/private/tmp") (subpath "/var/folders") (subpath "/dev"))',
`(deny file-read* ${deny})`,
"(allow network-outbound network-inbound)"].join("\n");
fs.writeFileSync("/tmp/probe.sbpl",prof);
console.log(prof);
