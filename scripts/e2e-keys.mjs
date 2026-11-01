// Credentials and billing UI against an ISOLATED dev runner + relay + Vite.
//   flock -o /tmp/claude-1001/e2e.lock env BASE=http://127.0.0.1:5261 \
//     CREDENTIAL_FILE=/tmp/claude-1001/keys/dev/credentials.json node scripts/e2e-keys.mjs
// Source badges below use synthetic confirmed reports in the dev browser store: UI checks only.
// REAL_HARNESSES=1 adds real sessions on each source, side by side with a plan session while a key
// is set: picker, label, a tiny plan turn, a fake key stopping with no fallback, resume, a replaced
// and an unset key, Source, TUIs and /proc environment names. Needs RUNNER_PID_FILE, TMUX_SOCKET and
// RESTART_RUNNER from the stack. KEYS_ROOT moves the artifact root. It uses only the owner's
// explicitly trusted scratch folders. Valid API-key billing remains an owner check; keys must never
// be pasted into chat.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
const { chromium } = await import(process.env.PLAYWRIGHT ?? "/home/ubuntu/foliation/web/site/node_modules/playwright/index.mjs");
const BASE = process.env.BASE ?? "http://127.0.0.1:5261";
const ROOT = process.env.KEYS_ROOT ?? "/tmp/claude-1001/keys";
assertLocal();
function assertLocal() { if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(BASE).hostname)) throw new Error("Use an isolated loopback dev stack"); }
const FILE = resolve(process.env.CREDENTIAL_FILE ?? "");
if (!FILE.startsWith(`${ROOT}/`) || !FILE.endsWith("/credentials.json")) throw new Error("CREDENTIAL_FILE must identify the isolated keys test runner's credentials.json");
const SHOTS = process.env.SHOTS ?? `${ROOT}/shots`;
mkdirSync(SHOTS, { recursive: true });
const secrets = [];
const newKey = () => { const key = `test-${randomBytes(24).toString("hex")}`; secrets.push(key); return key; };
const assert = (v, message) => { if (!v) throw new Error(message); };
const browser = await chromium.launch();
const errors = [];
const logs = [];
const incoming = [];
const outgoing = [];
const makePage = async (phone = false) => {
  const ctx = await browser.newContext({ timezoneId: "America/Los_Angeles", viewport: phone ? { width: 375, height: 812 } : { width: 1280, height: 900 }, ...(phone ? { isMobile: true, hasTouch: true } : {}) });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => logs.push(m.text()));
  p.on("websocket", (w) => { w.on("framereceived", (f) => incoming.push(String(f.payload))); w.on("framesent", (f) => outgoing.push(String(f.payload))); });
  await p.goto(`${BASE}/#/credentials`);
  await p.getByRole("form", { name: "Anthropic API key", exact: true }).waitFor();
  const online = await p.evaluate(() => globalThis.__tetherStore.getState().runners.filter((r) => r.online).map((r) => r.id));
  if (online.length !== 1 && !process.env.RUNNER_ID) throw new Error("Multiple runners: identify the isolated test runner with RUNNER_ID");
  if (process.env.RUNNER_ID && online.length > 1) await p.getByLabel("Runner", { exact: true }).selectOption(process.env.RUNNER_ID);
  if (process.env.RUNNER_ID) assert(online.includes(process.env.RUNNER_ID), "RUNNER_ID is not online");
  return p;
};
const slot = (p, label) => p.getByRole("form", { name: label, exact: true });
const isSet = async (p, label, yes) => { await p.waitForFunction(({ label, yes }) => { const f = [...document.forms].find((f) => f.getAttribute("aria-label") === label); return !!f && /^Set(?: ·|$)/.test(f.querySelector(".t-credential-status")?.textContent ?? "") === yes; }, { label, yes }); };
const screenshot = async (p, name) => { for (const input of await p.locator('input[type="password"]').all()) assert(await input.inputValue() === "", "key input wasn't cleared before screenshot"); await p.screenshot({ path: `${SHOTS}/${name}.png` }); };
const save = async (p, label, key) => {
  const form = slot(p, label);
  await form.locator('input[type="password"]').fill(key);
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await isSet(p, label, true);
  assert(await form.locator('input[type="password"]').inputValue() === "", "key retained in input after save");
  assert((statSync(FILE).mode & 0o777) === 0o600, "credentials file is not mode 600");
  assert(readFileSync(FILE, "utf8").includes(key), "saved key absent from private file");
  assert(!(await p.locator("body").innerText()).includes(key), "key echoed in page");
};
const unset = async (p, label) => { await slot(p, label).getByRole("button", { name: "Unset", exact: true }).click(); await isSet(p, label, false); };
const noOverflow = async (p) => assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "page overflows sideways");
let runner;
let session;
async function inject(p, billing, theme, cost = { usd: 0.0123, estimated: true, complete: true }) {
  await p.evaluate(({ runner, session, billing, theme, cost }) => {
    for (const el of document.querySelectorAll("[data-theme]")) { el.setAttribute("data-theme", theme); el.style.colorScheme = theme; }
    document.documentElement.style.colorScheme = theme;
    const store = globalThis.__tetherStore;
    const current = store.getState();
    const key = `${runner}\u0000${session}`;
    const summary = { id: session, nativeId: session.split(":")[1], harness: "claude", projectPath: "/tmp/claude-1001/keys/ui", title: "Billing indicator", mode: "live", status: "running", updatedAt: Date.now(), billing };
    store.setState({ summaries: { ...current.summaries, [runner]: { ...(current.summaries[runner] ?? { seq: -1 }), sessions: { ...(current.summaries[runner]?.sessions ?? {}), [session]: summary } } }, views: { ...current.views, [key]: { session: summary, window: { messages: [{ id: "ui", role: "notice", ts: Date.now(), parts: [{ type: "text", text: "Billing display check" }] }], hasOlder: false }, state: { mode: "live", status: "idle", model: "haiku", effort: "low", permissionMode: "default", requests: [], queue: [], billing, cost, plan: { week: { percent: 63 } } }, capabilities: { canSteer: true, terminal: "handoff", subagents: { view: false, stop: false, steer: false } } } } });
  }, { runner, session, billing, theme, cost });
  await p.locator(".t-input").waitFor();
}
async function call(p, op, args) {
  return p.evaluate(async ({runner,op,args}) => {
    const url=performance.getEntriesByType("resource").map((e)=>e.name).find((n)=>n.includes("/src/connection.ts")) ?? "/src/connection.ts";
    const {rpc}=await import(url);
    return rpc(runner,op,args);
  },{runner,op,args});
}
// Every process on the box, so the runner, harnesses, helpers and tmux are covered across restarts.
// Run while keys are live, not just at the end, when their processes are gone.
let argvChecks=0;
function argvAudit() {
  for(const pid of readdirSync("/proc").filter((n)=>/^\d+$/.test(n))) {
    let argv;
    try { argv=readFileSync(`/proc/${pid}/cmdline`); } catch { continue; }
    argvChecks++;
    for(const key of secrets) assert(!argv.includes(Buffer.from(key)),`key found in the argv of pid ${pid}`);
  }
}
// Names only: a value is never read into a message. Reading /proc/<pid>/environ is limited to what
// this test stack started.
const KEY_VARS=["ANTHROPIC_API_KEY","ANTHROPIC_AUTH_TOKEN","OPENAI_API_KEY","CODEX_API_KEY","AZURE_OPENAI_API_KEY","TETHER_CODEX_API_KEY","TETHER_GATEWAY_KEY"];
function descendants(roots) {
  const kids=new Map();
  for(const pid of readdirSync("/proc").filter((n)=>/^\d+$/.test(n))) {
    try { const stat=readFileSync(`/proc/${pid}/stat`,"utf8"); const ppid=stat.slice(stat.lastIndexOf(")")+2).split(" ")[1]; (kids.get(ppid) ?? kids.set(ppid,[]).get(ppid)).push(pid); } catch {}
  }
  const all=[]; const queue=roots.map(String);
  while(queue.length) { const pid=queue.shift(); all.push(pid); queue.push(...(kids.get(pid) ?? [])); }
  return all;
}
const runnerPid=()=>readFileSync(process.env.RUNNER_PID_FILE,"utf8").trim();
const panePids=()=>{ try { return execFileSync("tmux",["-L",process.env.TMUX_SOCKET,"list-panes","-a","-F","#{pane_pid}"],{encoding:"utf8"}).split("\n").filter(Boolean); } catch { return []; } };
const started=()=>[...descendants([runnerPid()]).slice(1),...descendants(panePids())];
function keyVars(pid) {
  let env;
  try { env=readFileSync(`/proc/${pid}/environ`); } catch { return undefined; }
  // Claude's settings blank its auth variables for what it starts: an empty one carries nothing.
  const names=env.toString("latin1").split("\0").filter((e)=>!e.endsWith("=")).map((e)=>e.split("=")[0]);
  return { names:KEY_VARS.filter((n)=>names.includes(n)), secret:secrets.some((key)=>env.includes(Buffer.from(key))) };
}
/** Nothing here carries a key: no variable by that name, and no test key under any name. */
function noKeyIn(pids,what) {
  let read=0;
  for(const pid of pids) {
    const r=keyVars(pid);
    if(!r) continue;
    read++;
    assert(!r.names.length,`${what}: pid ${pid} has ${r.names.join(", ")}`);
    assert(!r.secret,`${what}: pid ${pid} has a key in its environment`);
  }
  assert(read>0,`${what}: no process to read`);
  console.log(`ok ${what}: no key variable in ${read} processes`);
}
const privateHosts=()=>{ try { return readdirSync(`${dirname(FILE)}/codex-keys`).flatMap((id)=>{ try { return [JSON.parse(readFileSync(`${dirname(FILE)}/codex-keys/${id}/daemon.json`,"utf8")).pid]; } catch { return []; } }); } catch { return []; } };
const viewOf=(p,id)=>p.evaluate(({runner,id})=>{const v=globalThis.__tetherStore.getState().views[`${runner}\u0000${id}`];return v?{state:v.state,messages:v.window?.messages??[]}:null;},{runner,id});
const open=(p,id)=>p.goto(`${BASE}/#/s/${encodeURIComponent(runner)}/${encodeURIComponent(id)}`);
/** No turn runs on anything but the cheap model at Low. */
async function confirmModel(p,id,model,harness) {
  await p.waitForFunction(({runner,id,model,harness})=>{const s=globalThis.__tetherStore.getState().views[`${runner}\u0000${id}`]?.state;return s&&s.model===model&&(harness==="claude"||s.effort==="low");},{runner,id,model,harness},{timeout:60000});
}
const SAY="Reply exactly OK. Do not use tools.";
const replied=(m)=>m.role==="assistant"&&m.parts?.some((part)=>part.type==="text"&&/\bOK\b/.test(part.text));
/** A turn on a plan: its reply, or the plan's own limit, which is that plan answering. */
async function planTurn(p,id,model,harness) {
  await confirmModel(p,id,model,harness);
  const before=(await viewOf(p,id)).messages.filter(replied).length;
  await call(p,"send",{sessionId:id,text:SAY});
  const ending=await p.waitForFunction(({runner,id,before})=>{const v=globalThis.__tetherStore.getState().views[`${runner}\u0000${id}`];if(v?.state?.status!=="idle")return false;const msgs=v.window?.messages??[];if(msgs.filter((m)=>m.role==="assistant"&&m.parts?.some((part)=>part.type==="text"&&/\bOK\b/.test(part.text))).length>before)return "replied";return /usage limit/i.test(JSON.stringify(msgs))&&"limit";},{runner,id,before},{timeout:120000}).then((h)=>h.jsonValue());
  if(ending==="limit") console.log("NOT VERIFIED: the plan is at its usage limit, so a reply wasn't seen; its label and its own limit error were");
  return ending;
}
/** A turn on a fake key: it stops, on that source, with no answer from anywhere. */
async function keyTurn(p,id,label) {
  const errorsBefore=(await viewOf(p,id)).messages.filter((m)=>m.error||(m.role==="notice"&&m.level==="error")).length;
  await call(p,"send",{sessionId:id,text:SAY});
  await p.waitForFunction(({runner,id,errorsBefore})=>{const v=globalThis.__tetherStore.getState().views[`${runner}\u0000${id}`];return v?.state?.status==="idle"&&v.window?.messages?.filter((m)=>m.error||(m.role==="notice"&&m.level==="error")).length>errorsBefore;},{runner,id,errorsBefore},{timeout:90000});
  const after=await viewOf(p,id);
  assert(!after.messages.some(replied),"a fake key answered: something fell back");
  assert(await p.locator(".t-paid-badge > span").first().innerText()===label,"a failed key changed the source");
}
async function pickerShots(p,phone,cfg) {
  for(const [name,q] of [["desktop",p],["phone",phone]]) {
    await q.evaluate(()=>{location.hash="#/";globalThis.__tetherStore.setState({newSessionOpen:true});});
    const d=q.getByRole("dialog");
    await d.getByRole("radio",{name:cfg.harnessLabel,exact:true}).click();
    const source=d.getByLabel("Source",{exact:true});
    await source.waitFor({timeout:30000});
    assert((await source.locator("option:checked").innerText())===cfg.plan,"the picker doesn't start on the subscription");
    const offered=await source.locator("option").allInnerTexts();
    assert(offered.includes(cfg.plan)&&offered.includes(cfg.label),`picker offers ${offered.join(", ")}`);
    await noOverflow(q);
    await screenshot(q,`picker-${cfg.source}-${name}`);
    await source.selectOption({label:cfg.label});
    await q.locator(".t-source-api").waitFor();
    await screenshot(q,`picker-${cfg.source}-${name}-key`);
    await d.getByRole("button",{name:"Create",exact:true}).scrollIntoViewIfNeeded();
    await screenshot(q,`picker-${cfg.source}-${name}-bottom`);
    await d.getByRole("button",{name:"Cancel",exact:true}).click();
  }
}
/** The picker, the way a person does it: a key session, remembered as the choice. */
async function keyByDialog(p,cfg) {
  await p.evaluate(()=>{location.hash="#/";globalThis.__tetherStore.setState({newSessionOpen:true});});
  const d=p.getByRole("dialog");
  await d.getByRole("radio",{name:cfg.harnessLabel,exact:true}).click();
  await d.getByLabel("Source",{exact:true}).selectOption({label:cfg.label});
  await d.locator("#t-new-path").fill(cfg.path);
  const models=d.locator("label",{hasText:"Model"}).locator("select");
  const value=await p.waitForFunction((m)=>[...document.querySelectorAll("dialog option, [role=dialog] option")].find((o)=>o.value.includes(m))?.value,cfg.model,{timeout:60000});
  await models.selectOption(await value.jsonValue());
  await d.locator("label",{hasText:"Permissions"}).locator("select").selectOption(cfg.harness==="codex"?"read-only":"default");
  await d.getByRole("button",{name:"Create",exact:true}).click();
  await p.waitForFunction(()=>location.hash.startsWith("#/s/"),null,{timeout:90000});
  return decodeURIComponent(p.url().split("/").pop());
}
async function sideBySide(p,phone,cfg,planId,keyId) {
  const rows=await p.evaluate(({runner})=>Object.values(globalThis.__tetherStore.getState().summaries[runner].sessions).map((s)=>({id:s.id,billing:s.billing?.label})),{runner});
  assert(rows.find((r)=>r.id===planId)?.billing===cfg.plan,`list has ${JSON.stringify(rows.find((r)=>r.id===planId))} for the plan session`);
  assert(rows.find((r)=>r.id===keyId)?.billing===cfg.label,`list has ${JSON.stringify(rows.find((r)=>r.id===keyId))} for the key session`);
  await p.evaluate(()=>{location.hash="#/";});
  await p.locator(".t-rows .t-api-marker").first().waitFor({timeout:15000});
  await noOverflow(p);
  await screenshot(p,`side-${cfg.source}-desktop`);
  await phone.reload();
  await phone.getByRole("button",{name:/navigation|menu/i}).first().tap();
  await phone.locator(".t-rows .t-api-marker").first().waitFor({timeout:15000});
  await screenshot(phone,`side-${cfg.source}-phone`);
  await phone.keyboard.press("Escape");
}
async function tuiStarts(p,id,cfg) {
  const opened=await call(p,"openTerminal",{sessionId:id,cols:80,rows:24});
  await new Promise((r)=>setTimeout(r,1500));
  let captured;
  try { captured=await call(p,"terminalText",{attachId:opened.attachId}); }
  catch(e) {
    const text=incoming.map((frame)=>{try{const m=JSON.parse(frame);return m.t==="term" && m.attachId===opened.attachId ? Buffer.from(m.data,"base64").toString("utf8") : "";}catch{return "";}}).join("");
    assert(!secrets.some((key)=>text.includes(key)),"key found in terminal output");
    console.error(`native ${cfg.source} TUI exited before capture:`,text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,""));
    throw e;
  }
  await call(p,"closeTerminal",{attachId:opened.attachId});
  return /trust this folder|Yes, I trust|Do you trust/i.test(captured.text);
}
async function realSources(p,phone) {
  const cl=process.env.CLAUDE_SCRATCH ?? "/home/ubuntu/.local/share/tether-dev-p3/projects/scratch";
  const cx=process.env.CODEX_SCRATCH ?? "/home/ubuntu/tether-scratch/p4/projects/scratch";
  const sources=[
    {source:"anthropic",label:"Anthropic API key",plan:"Claude plan",harness:"claude",harnessLabel:"Claude Code",path:cl,model:"haiku",mode:"default"},
    {source:"openai",label:"OpenAI API key",plan:"ChatGPT plan",harness:"codex",harnessLabel:"Codex",path:cx,model:"gpt-6-luna",mode:"read-only"},
    {source:"azure",label:"Azure",plan:"ChatGPT plan",harness:"codex",harnessLabel:"Codex",path:cx,model:"gpt-6-luna",mode:"read-only"},
  ];
  for(const cfg of sources.filter((c)=>!process.env.ONLY_SOURCE||c.source===process.env.ONLY_SOURCE)) {
    const {source,label,plan,harness,path,model,mode}=cfg;
    await p.goto(`${BASE}/#/credentials`);
    await slot(p,label).waitFor();
    if(source==="azure") await slot(p,label).getByLabel("Endpoint",{exact:true}).fill("https://example.invalid/openai/v1");
    await save(p,label,newKey());
    const choices=await call(p,"billingSources",{harness});
    const names=choices.options.map((o)=>o.billing.label);
    assert(names.includes(plan)&&names.includes(label),`sources: ${names.join(", ")}`);
    assert(choices.default==="subscription","a set key changed the default");
    await pickerShots(p,phone,cfg);
    let planId;
    if(source!=="azure") {
      // The key is set, and a plan session starts on the plan, as nothing changed.
      planId=(await call(p,"newSession",{harness,projectPath:path,model,effort:"low",permissionMode:mode,source:"subscription"})).sessionId;
      await open(p,planId);
      await p.locator(".t-usage-chip",{hasText:plan}).waitFor({timeout:60000});
      await planTurn(p,planId,model,harness);
      assert((await viewOf(p,planId)).state.billing?.label===plan,"the plan session's label changed");
      assert(await p.locator(".t-paid-badge").count()===0,"a plan session has the API badge");
      await screenshot(p,`real-${source}-plan-desktop`);
      noKeyIn(started(),`${plan} session beside a set key`);
      assert(privateHosts().length===0||source!=="openai","a plan session started a private process");
      console.log(`ok real ${source}: ${plan} session with the key set: label confirmed, a reply, no key anywhere`);
    }
    const id=await keyByDialog(p,cfg);
    await p.locator(".t-paid-badge > span:first-child",{hasText:label}).waitFor({timeout:90000});
    await call(p,"setEffort",{sessionId:id,effort:"low"});
    if(harness==="codex") await confirmModel(p,id,model,harness);
    assert((await call(p,"billingSources",{harness})).default===source,"an explicit choice wasn't remembered");
    if(harness==="codex") {
      const hosts=privateHosts();
      assert(hosts.length>0,"no private process for the key session");
      // The key stops at the private host's gateway: its Codex child has a placeholder, and no login.
      for(const pid of descendants(hosts).filter((pid)=>!hosts.map(String).includes(pid))) { const r=keyVars(pid); if(r) assert(!r.secret,`pid ${pid}: the key reached a Codex process`); }
      for(const home of readdirSync(`${dirname(FILE)}/codex-keys`)) assert(!readdirSync(`${dirname(FILE)}/codex-keys/${home}`).includes("auth.json"),"a key session's private home has a login");
    } else noKeyIn(descendants([runnerPid()]).slice(1),`${label} session's process`);
    await keyTurn(p,id,label);
    await screenshot(p,`real-${source}-failure`);
    await p.setViewportSize({width:375,height:812});
    await screenshot(p,`real-${source}-failure-phone`);
    await p.setViewportSize({width:1280,height:900});
    argvAudit();
    if(planId) {
      await sideBySide(p,phone,cfg,planId,id);
      console.log(`ok real ${source}: both sessions side by side, each with its own label`);
    }
    if(process.env.RESTART_RUNNER) {
      // The command belongs to the isolated test stack, never the production runner.
      execFileSync("sh",["-c",process.env.RESTART_RUNNER],{stdio:"inherit"});
      await open(p,id);
      await p.reload();
      await p.locator(".t-paid-badge > span:first-child",{hasText:label}).waitFor({timeout:90000});
      await keyTurn(p,id,label);
      console.log(`ok real ${source} runner restart: history resumed on the same source; rejected key stopped again`);
      if(planId) {
        await open(p,planId);
        await p.reload();
        await confirmModel(p,planId,model,harness);
        await planTurn(p,planId,model,harness);
        assert((await viewOf(p,planId)).state.billing?.label===plan,"resuming changed the plan session's source");
        assert(await p.locator(".t-paid-badge").count()===0,"a resumed plan session has the API badge");
        noKeyIn(started().filter((pid)=>!descendants(privateHosts()).includes(pid)),`resumed ${plan} session`);
        console.log(`ok real ${source}: an existing subscription session resumed after a restart, with the key still set`);
      }
    }
    if(source==="openai") {
      // A thread with no record here, which is what was refused before: it belongs to the shared daemon.
      const listed=(await call(p,"listSessions",{projectPath:cx})).sessions;
      const stored=listed.find((s)=>s.harness==="codex"&&!s.parentSessionId&&s.id!==planId&&s.id!==id&&s.status==="idle"&&!s.billing);
      assert(stored,"no stored Codex thread without a record");
      await open(p,stored.id);
      await p.locator("textarea.t-input[aria-label=Message]").waitFor({timeout:30000});
      await call(p,"setModel",{sessionId:stored.id,model});
      await call(p,"setEffort",{sessionId:stored.id,effort:"low"});
      await planTurn(p,stored.id,model,harness);
      await p.locator(".t-usage-chip",{hasText:plan}).waitFor({timeout:30000});
      await screenshot(p,"real-openai-stored-plan");
      console.log("ok real openai: a thread with no record, which used to be refused, ran on the plan with the key set, in place");
      const menu=p.getByRole("button",{name:"Session menu"});
      await menu.click();
      assert(await p.getByRole("menuitem",{name:"Source…"}).count()===0,"Codex offers Source; its threads don't cross app-servers");
      await p.keyboard.press("Escape");
    }
    if(source==="anthropic") {
      await open(p,planId);
      await p.getByRole("button",{name:"Session menu"}).click();
      await p.getByRole("menuitem",{name:"Source…"}).click();
      const d=p.getByRole("dialog");
      await d.getByLabel("Source",{exact:true}).selectOption({label});
      await screenshot(p,"real-source-dialog");
      await d.getByRole("button",{name:"Apply",exact:true}).click();
      await p.locator(".t-next-source",{hasText:label}).waitFor();
      assert((await viewOf(p,planId)).state.billing?.label===plan,"the label moved before the harness confirmed");
      await screenshot(p,"real-source-next-desktop");
      await p.setViewportSize({width:375,height:812});
      await noOverflow(p);
      await screenshot(p,"real-source-next-phone");
      await p.setViewportSize({width:1280,height:900});
      await call(p,"send",{sessionId:planId,text:SAY});
      await p.locator(".t-paid-badge > span:first-child",{hasText:label}).waitFor({timeout:60000});
      await p.getByText("Anthropic API key failed",{exact:false}).first().waitFor({timeout:90000});
      assert(await p.locator(".t-next-source").count()===0,"the next-source chip stayed after the start confirmed");
      await p.locator(`[role=status], .t-chip-term`).first().waitFor({timeout:5000}).catch(()=>{});
      await call(p,"setSessionSource",{sessionId:planId,source:"subscription"});
      await planTurn(p,planId,model,harness);
      await p.locator(".t-usage-chip",{hasText:plan}).waitFor({timeout:30000});
      console.log("ok real anthropic: Source changes at the next start, the label follows the harness, both ways");
    }
    // The session's TUI, on its source. Nothing is typed in it; no trust prompt is accepted.
    if(planId) {
      const trust=await tuiStarts(p,planId,cfg);
      noKeyIn(descendants(panePids()),`${plan} TUI`);
      if(harness==="claude") {
        const refused=await call(p,"setSessionSource",{sessionId:planId,source}).then(()=>undefined,(e)=>String(e));
        assert(/Close the terminal first/.test(refused ?? ""),`a TUI didn't block Source: ${refused}`);
      }
      await call(p,"endTerminal",{sessionId:planId});
      console.log(`ok real ${source}: ${plan} TUI started with no key; ${trust?"trust prompt left unaccepted":"no trust prompt"}`);
    }
    try {
      await open(p,id);
      await p.locator(".t-paid-badge").waitFor({timeout:30000});
      const trust=await tuiStarts(p,id,cfg);
      await p.locator(".t-chip-term").click();
      await p.locator(".t-term-agent").waitFor();
      await p.locator(".t-term-agent").click();
      await p.locator(".t-term-api-badge").waitFor({timeout:30000});
      assert((await p.locator(".t-term-api-badge").innerText()).includes(label),"terminal lost its source badge");
      await p.setViewportSize({width:375,height:812});
      await screenshot(p,`real-${source}-terminal-phone`);
      argvAudit();
      const badge=await p.locator(".t-term-api-badge").boundingBox();
      assert(badge && badge.x>=0 && badge.x+badge.width<=375,"terminal source badge is not visible on phone");
      await p.setViewportSize({width:1280,height:900});
      // Quit uses only cancel sequences when a prompt is up; no trust is accepted.
      await call(p,"endTerminal",{sessionId:id});
      await p.getByRole("button",{name:"Close terminal panel",exact:true}).click();
      console.log(`ok real ${source} TUI startup: source pinned; ${trust?"trust prompt left unaccepted":"no trust prompt"}; no TUI message sent`);
    } catch(e) {
      if(!/could not confirm|cannot confirm/i.test(String(e))) throw e;
      console.log(`ok real ${source} TUI refused an unconfirmed source before send`);
    }
    // A replaced key: the same session carries on with it, and it's the new key that's refused.
    await p.goto(`${BASE}/#/credentials`);
    await slot(p,label).waitFor();
    if(source==="azure") await slot(p,label).getByLabel("Endpoint",{exact:true}).fill("https://example.invalid/openai/v1");
    await save(p,label,newKey());
    await open(p,id);
    await p.locator(".t-paid-badge").waitFor({timeout:30000});
    await keyTurn(p,id,label);
    console.log(`ok real ${source}: a replaced key carries on in the same session`);
    await call(p,"unsetCredential",{source});
    const refused=await call(p,"send",{sessionId:id,text:SAY}).then(()=>undefined,(e)=>String(e));
    assert(refused?.includes(`uses ${label}, which isn't set`),`unset key: ${refused}`);
    await p.getByText(`uses ${label}, which isn't set`,{exact:false}).first().waitFor({timeout:15000});
    assert(await p.locator(".t-paid-badge > span").first().innerText()===label,"unset changed the session's label");
    assert(!(await viewOf(p,id)).messages.some(replied),"an unset key's session answered");
    await screenshot(p,`real-${source}-unset`);
    await p.setViewportSize({width:375,height:812});
    await screenshot(p,`real-${source}-unset-phone`);
    await p.setViewportSize({width:1280,height:900});
    console.log(`ok real ${source}: unset stops with the source named, nothing sent, no fallback`);
  }
}
function contrast(a, b) {
  const lum = (s) => { const c = s.match(/[\d.]+/g).slice(0, 3).map(Number).map((x) => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; }); return c[0] * .2126 + c[1] * .7152 + c[2] * .0722; };
  const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
try {
  const desktop = await makePage();
  const phone = await makePage(true);
  runner = process.env.RUNNER_ID ?? await desktop.evaluate(() => globalThis.__tetherStore.getState().runners.find((r) => r.online)?.id);
  assert(runner, "no online test runner");
  for (const label of ["Anthropic API key", "OpenAI API key", "Azure"]) await isSet(desktop, label, false);
  // Only an isolated, initially empty runner is allowed: never overwrite a person's credentials.
  await save(desktop, "Anthropic API key", newKey());
  await screenshot(desktop, "credentials-desktop-set");
  await save(desktop, "Anthropic API key", newKey());
  await unset(desktop, "Anthropic API key");
  await save(desktop, "OpenAI API key", newKey());
  await slot(desktop, "Azure").getByLabel("Endpoint", { exact: true }).fill("https://example.invalid/openai/v1");
  await slot(desktop, "Azure").getByLabel("Deployment", { exact: true }).fill("gpt-6-luna");
  await save(desktop, "Azure", newKey());
  await save(desktop, "Anthropic API key", newKey());
  await isSet(desktop, "OpenAI API key", true);
  await screenshot(desktop, "credentials-desktop-all-set");
  await unset(desktop, "Azure");
  await isSet(desktop, "OpenAI API key", true);
  await unset(desktop, "OpenAI API key");
  await unset(desktop, "Anthropic API key");
  await desktop.reload();
  await desktop.getByRole("form", { name: "Anthropic API key", exact: true }).waitFor();
  for (const label of ["Anthropic API key", "OpenAI API key", "Azure"]) await isSet(desktop, label, false);
  await phone.reload();
  await phone.getByRole("form", { name: "Anthropic API key", exact: true }).waitFor();
  await noOverflow(phone);
  await screenshot(phone, "credentials-phone-unset");
  console.log("ok credentials save, replace, all three set together, unset one at a time, reload; inputs clear and file is private");
  if(process.env.REAL_HARNESSES === "1") await realSources(desktop, phone);
  session = `claude:ui-keys-${randomBytes(8).toString("hex")}`;
  for (const [name, p] of [["desktop", desktop], ["phone", phone]]) {
    await p.goto(`${BASE}/#/s/${encodeURIComponent(runner)}/${encodeURIComponent(session)}`);
    // Let the harmless subscribe of the synthetic id fail before injecting UI-only state.
    await p.waitForFunction(({ runner, session }) => globalThis.__tetherStore?.getState().views[`${runner}\u0000${session}`]?.error, { runner, session });
    for (const theme of ["dark", "light"]) {
      for (const [source, billing] of [["anthropic", { kind: "apiKey", label: "Anthropic API key" }], ["openai", { kind: "apiKey", label: "OpenAI API key" }], ["azure", { kind: "provider", label: "Azure" }]]) {
        await inject(p, billing, theme);
        const badge = p.locator(".t-paid-badge");
        assert(await badge.locator(":scope > span").first().innerText() === billing.label, "wrong billing badge");
        assert(await badge.locator(".t-api-cost").innerText() === "$0.01 est.", "session estimate missing or mislabeled");
        assert(await p.locator(".t-chips > :first-child").getAttribute("class").then((v) => v.includes("t-paid-badge")), "API badge isn't first");
        const bounds = await badge.boundingBox();
        assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= (await p.viewportSize()).width, "API badge is off screen");
        assert(!(await p.locator(".t-header").innerText()).includes("63%"), "plan usage leaked onto API session");
        const colours = await p.evaluate(() => { const a = getComputedStyle(document.querySelector(".t-paid-badge")), c = getComputedStyle(document.querySelector(".t-api-composer")); return { fg: a.color, bg: a.backgroundColor, border: c.borderTopColor }; });
        assert(colours.bg === colours.border, "composer doesn't use the billing colour");
        assert(contrast(colours.fg, colours.bg) >= 4.5, "billing badge contrast is below 4.5:1");
        assert(await p.locator(".t-api-composer").getAttribute("data-billing") === billing.label, "composer has wrong source");
        await noOverflow(p);
        await screenshot(p, `${name}-${theme}-${source}`);
        await p.evaluate(() => { const c = document.querySelector(".t-chip-options"); c.scrollLeft = c.scrollWidth; });
        const after = await badge.boundingBox();
        assert(after.x === bounds.x, "billing badge moved with scrolling chips");
      }
      await inject(p, { kind: "apiKey", label: "Anthropic API key" }, theme, { usd: 1, estimated: true, complete: false });
      assert(await p.locator(".t-api-cost").innerText() === "Cost unknown", "partial subtotal shown as full total");
      await screenshot(p, `${name}-${theme}-partial-cost`);
      await inject(p, { kind: "unknown", label: "Unknown" }, theme);
      assert(await p.locator(".t-paid-badge, .t-api-composer").count() === 0, "unknown shown as API");
      assert((await p.locator(".t-header").innerText()).includes("Unknown"), "unknown billing is hidden");
      await screenshot(p, `${name}-${theme}-unknown`);
      await inject(p, { kind: "plan", label: "Claude plan" }, theme);
      assert(await p.locator(".t-paid-badge, .t-api-composer").count() === 0, "subscription has API colour");
      assert((await p.locator(".t-chips > :first-child").innerText()).includes("Week 63%"), "plan usage isn't first before Mode");
      await screenshot(p, `${name}-${theme}-subscription`);
    }
    await inject(p, { kind: "apiKey", label: "Anthropic API key" }, "dark");
    await p.evaluate(({ runner, session }) => {
      const store=globalThis.__tetherStore, key=`${runner}\u0000${session}`;
      const v=store.getState().views[key];
      store.setState({ views: {...store.getState().views, [key]: {...v, window: {...v.window, messages: [{id:"limit",role:"assistant",ts:Date.now(),error:"usage limit",parts:[{type:"text",text:"You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 1st, 2026 2:33 AM."}]}]}}}});
    }, {runner,session});
    await p.getByText(/Oct 31, 2026, 7:33 PM PDT/).waitFor();
    await screenshot(p, `${name}-local-retry`);
    // Inline edit is local until saved: Escape sends no rename RPC and restores the title.
    await p.getByRole("button", { name: "Rename session: Billing indicator", exact: true }).click();
    await p.getByRole("textbox", { name: "Session title", exact: true }).fill("Cancelled rename");
    await p.getByRole("textbox", { name: "Session title", exact: true }).press("Escape");
    assert(await p.getByRole("button", { name: "Rename session: Billing indicator", exact: true }).count() === 1, "Escape didn't cancel title edit");
    await inject(p, { kind: "apiKey", label: "Anthropic API key" }, "dark");
    await p.evaluate(() => { location.hash = "#/"; });
    await p.locator(`.t-inbox-row[data-session="${session}"] .t-api-marker`).waitFor();
    if (name === "desktop") assert(await p.locator(".t-rows .t-api-marker").count() > 0, "sidebar API marker missing");
    await screenshot(p, `${name}-home-api`);
    console.log(`ok ${name}: all source badges, neutral unknown, quiet subscription, phone pinning, composer colour, Home/sidebar markers, title cancel`);
  }
  for (const key of secrets) {
    assert(!incoming.some((v) => v.includes(key)), "runner sent a key back to the browser");
    assert(!logs.some((v) => v.includes(key)), "browser console contains a key");
    assert(outgoing.filter((v) => v.includes(key)).length === 1, "browser didn't send the key exactly once");
  }
  argvAudit();
  const scan = (dir) => { for (const f of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, f.name); try { if (f.isDirectory()) scan(path); else if (f.isFile() && resolve(path) !== FILE) { const bytes = readFileSync(path); for (const key of secrets) assert(!bytes.includes(Buffer.from(key)), `key found outside private credentials file: ${path}`); } } catch (e) { if (e.code !== "ENOENT") throw e; } } };
  scan(ROOT);
  assert(argvChecks>0,"no process was audited");
  console.log(`ok audit: ${secrets.length} fake keys in no argv (${argvChecks} process reads), nowhere under ${ROOT} but the private file`);
  assert(errors.length === 0, `browser errors: ${errors.join("; ")}`);
  console.log("all passed; synthetic snapshots verify rendering; valid API-key billing remains an owner check");
} catch(error) {
  let n=0;
  for(const context of browser.contexts()) for(const p of context.pages()) {
    await screenshot(p,`failure-${++n}`).catch(()=>{});
    const body=await p.locator("body").innerText().catch(()=>"closed");
    assert(!secrets.some((key)=>body.includes(key)),"key found in failure DOM");
    console.error("failure page",p.url(),body);
  }
  console.error("browser errors",errors);
  throw error;
} finally { await browser.close(); }
