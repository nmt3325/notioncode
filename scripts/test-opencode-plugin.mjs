import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { bundledBun } from "../dist/plugin/config.js"
import { NotionModels } from "../dist/plugin/models.js"
const exec=promisify(execFile), project=resolve(import.meta.dirname,"..")
const source=process.env.OPENCODE_MCP_RUNTIME_DIR ?? join(project,".opencode-runtime"), bun=process.env.OPENCODE_MCP_BUN ?? bundledBun()
const temp=await mkdtemp(join(tmpdir(),"opencode-provider-host-"))
try {
  const workspace=join(temp,"workspace"), home=join(temp,"home"), journal=join(temp,"journal.json"), log=join(temp,"calls.jsonl")
  await mkdir(workspace);await mkdir(home)
  const fixture=join(temp,"provider.mjs")
  await writeFile(fixture, `
import {providerHooks} from ${JSON.stringify(pathToFileURL(join(project,"dist/plugin.js")).href)};
import {NotionTransport} from ${JSON.stringify(pathToFileURL(join(project,"dist/plugin/transport.js")).href)};
import {Journal} from ${JSON.stringify(pathToFileURL(join(project,"dist/plugin/storage.js")).href)};
import {appendFile} from 'node:fs/promises';
export default {id:'notion-provider-host-fixture',server:async()=>{
 const journal=new Journal(${JSON.stringify(journal)});await journal.load();
 const backend={send:async input=>{await appendFile(${JSON.stringify(log)},JSON.stringify({prompt:input.prompt,conversationId:input.conversationId,fresh:input.fresh,model:input.model,attachments:input.attachments,reasoningEffort:input.reasoningEffort})+'\\n');return 'NOTION_HOST_REPLY '+input.prompt},interrupt:async()=>{}};
 const transport=new NotionTransport(backend,journal,'host fixture');
 return providerHooks(transport,()=>transport.close());
}};
`)
  await writeFile(join(workspace,"opencode.json"),JSON.stringify({plugin:[pathToFileURL(fixture).href]}))
  const env={PATH:process.env.PATH,HOME:home,XDG_CONFIG_HOME:join(home,"config"),XDG_DATA_HOME:join(home,"data"),XDG_STATE_HOME:join(home,"state"),XDG_CACHE_HOME:join(home,"cache"),OPENCODE_DISABLE_MODELS_FETCH:"true",OPENCODE_DISABLE_DEFAULT_PLUGINS:"true",OPENCODE_DISABLE_CLAUDE_CODE:"true",OPENCODE_DISABLE_EXTERNAL_SKILLS:"true"}
  async function cli(args){const pending=exec(bun,[join(source,"packages/opencode/src/index.ts"),...args],{cwd:workspace,env,timeout:90000,maxBuffer:4*1024*1024});pending.child.stdin.end();return pending}
  const run=args=>cli(["run","--format","json",...args])
  const models=new NotionModels(),listed=await cli(["models","notion-ai"])
  for(const model of models.choices)assert.ok(listed.stdout.includes(`notion-ai/${model.id}`),`Model missing from actual OpenCode list: ${model.id}`)
  const first=await run(["first-input"]);assert.match(first.stdout,/NOTION_HOST_REPLY/)
  const events=first.stdout.split("\n").flatMap(line=>{try{return [JSON.parse(line)]}catch{return []}}), session=events.find(event=>event.sessionID)?.sessionID
  assert.ok(session,"real OpenCode did not return a session")
  const second=await run(["--session",session,"second-input"]);assert.match(second.stdout,/NOTION_HOST_REPLY/)
  const third=await run(["--session",session,"--model","notion-ai/gpt-5.4","model-switch-input"]);assert.match(third.stdout,/NOTION_HOST_REPLY/)
  await writeFile(join(workspace,"opencode.json"),JSON.stringify({plugin:[pathToFileURL(fixture).href],model:"notion-ai/gemini-3.1-pro"}))
  const fourth=await run(["--session",session,"configured-model-input"]);assert.match(fourth.stdout,/NOTION_HOST_REPLY/)
  const attachment=join(workspace,"attachment.png"),attachmentBase64="iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAF0lEQVR4nGP4z8BAEiJN9aiGUQ1DSgMAkPn/Afnh+ngAAAAASUVORK5CYII=";await writeFile(attachment,Buffer.from(attachmentBase64,"base64"))
  const fifth=await run(["--session",session,"attachment-input","--model","notion-ai/gpt-6-astra","--file",attachment]);assert.match(fifth.stdout,/NOTION_HOST_REPLY/)
  const calls=(await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line))
  assert.equal(calls.length,5);assert.equal(calls[0].fresh,true);assert.equal(calls[1].fresh,false);assert.equal(calls[0].conversationId,calls[1].conversationId);assert.equal(calls[1].prompt,"second-input")
  assert.equal(calls[0].model,models.defaultModel);assert.equal(calls[2].model,models.resolve("gpt-5.4"));assert.equal(calls[3].model,models.resolve("gemini-3.1-pro"));assert.equal(calls[4].model,"gpt-6-astra");assert.equal(calls[4].attachments.length,1);assert.equal(calls[4].attachments[0].base64,attachmentBase64);assert.equal(calls[4].attachments[0].mimeType,"image/png")
  for(const call of calls.slice(1))assert.equal(call.conversationId,calls[0].conversationId)
  await writeFile(join(workspace,"opencode.json"),JSON.stringify({plugin:[pathToFileURL(join(project,"dist/plugin.js")).href]}))
  let failedOutput=""
  try {const reply=await run(["setup-failure"]);failedOutput=reply.stdout+reply.stderr}
  catch(error){assert.ok(!error.killed,"setup failure must exit without retrying until timeout");failedOutput=String(error.stdout)+String(error.stderr)}
  assert.match(failedOutput,/OPENCODE_NOTION_MCP_URL/)
  console.log("PASS: real OpenCode model catalog, GPT-6 Astra routing, image attachments, configured default, assistant rendering and persisted conversation continuation")
} finally {await rm(temp,{recursive:true,force:true})}
