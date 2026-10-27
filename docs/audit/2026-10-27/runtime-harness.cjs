const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, BrowserWindow } = require('electron');
const root = process.cwd();
const out = path.join(process.env.TEMP, 'tarkov-companion-audit-20261027');
const profile = path.join(out, 'isolated-profile');
fs.mkdirSync(profile, {recursive:true});
const empty = path.join(out, 'empty-game-data');
fs.mkdirSync(empty, {recursive:true});
app.setPath('userData', profile);
app.setPath('appData', out);
process.env.APPDATA = out;
process.env.LOCALAPPDATA = out;
process.env.ProgramFiles = empty;
process.env['ProgramFiles(x86)'] = empty;
process.env.TC_SCREENSHOTS_DIR = empty;
delete process.env.VITE_DEV_SERVER_URL;
app.setLoginItemSettings = () => {};
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({logsPath:empty, paused:true, startMinimized:true, startWithWindows:false, minimizeToTray:false, initialBackfillDone:true, setupDone:true, updateMode:'off', trackPosition:false, clearPositionShots:false, cleanAfterUpdate:false, scanHotkey:'', searchBar:false}));
const start = performance.now();
const sleep = ms => new Promise(r=>setTimeout(r,ms));
const timeout = setTimeout(()=>{fs.writeFileSync(path.join(out,'runtime-error.txt'),'Timed out');app.quit();},65000);
require(path.join(root, 'dist-electron/main.cjs'));
app.whenReady().then(async()=>{
 try {
  let win;
  let dom;
  for(let i=0;i<400;i++){
   win = BrowserWindow.getAllWindows()[0];
   if(win && !win.webContents.isLoading()) {
    dom = await win.webContents.executeJavaScript('({ready:!!document.querySelector("main"), text:document.body.innerText.slice(0,400)})').catch(()=>null);
    if(dom?.ready) break;
   }
   await sleep(100);
  }
  const readyMs=performance.now()-start;
  if(!dom?.ready) throw new Error('React main did not render');
  await sleep(8000);
  const samples=[];
  app.getAppMetrics();
  for(let i=0;i<20;i++){
   await sleep(1000);
   const metrics=app.getAppMetrics();
   samples.push({elapsedMs:performance.now()-start,processCount:metrics.length,workingSetKiB:metrics.reduce((s,p)=>s+(p.memory?.workingSetSize??0),0),privateBytesKiB:metrics.reduce((s,p)=>s+(p.memory?.privateBytes??0),0),cpuPercentSum:metrics.reduce((s,p)=>s+(p.cpu?.percentCPUUsage??0),0),types:metrics.map(p=>p.type)});
  }
  const state=await win.webContents.executeJavaScript('window.desktop.getState().then(s=>({status:s.status,logsPath:s.logsPath}))');
  const result={date:'2026-10-27',kind:'isolated-unpackaged-hidden-first-run-smoke',limitations:['not a packaged release','hidden window, first-run screen over dashboard','watcher paused; tracking/hotkeys/searchbar/updater off','startup measures require-main-to-React-main, not launch-to-first-paint','no screenshot OCR or matcher assets','network/cache state not controlled','sum working sets double-counts shared pages','Electron CPU percentages retained without normalization'],readyMs,dom,state,versions:process.versions,samples};
  fs.writeFileSync(path.join(out,'runtime.json'),JSON.stringify(result,null,2));
 } catch(e){fs.writeFileSync(path.join(out,'runtime-error.txt'),String(e.stack||e));}
 finally{clearTimeout(timeout);app.quit();}
});
