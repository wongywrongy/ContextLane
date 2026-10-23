import React, { useEffect, useState } from 'react';
import { environmentInspection, type Environment, type EnvironmentInspection, type Project } from '../src/shared/contracts';
import { PanelSection } from './panel-section';
import { branchLabel } from './projects';

export function CheckoutControls({checkouts,environments,working,onRequest,onAction,api,onChanged,selectedPath,onSelect}: {
  checkouts:Project[]; environments:Record<string,Environment>; working:boolean;
  onRequest:(path:string)=>void; onAction:(id:string,action:'start'|'stop'|'recover')=>void;
  api:(path:string,body:unknown)=>Promise<any>; onChanged:()=>void;
  selectedPath?:string;onSelect?:(path:string)=>void;
}) {
  const [selection,setSelection] = useState(checkouts[0].path);
  const checkout = checkouts.find(p=>p.path===(selectedPath ?? selection)) ?? checkouts[0];
  const [inspection,setInspection] = useState<EnvironmentInspection|null>(null);
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [editing,setEditing] = useState(false);
  const [preparationReview,setPreparationReview] = useState(false);
  const [draft,setDraft] = useState(''), [tools,setTools] = useState<Record<string,string>>({});
  const refresh = async()=>{
    try { const value = environmentInspection.parse(await api('/api/tools/inspect_environment',{path:checkout.path})); setInspection(value); setError(''); return value; }
    catch(error) { setError(String(error)); return null; }
  };
  useEffect(()=>{
    let active = true;
    setInspection(null); setEditing(false); setError('');
    const load = async()=>{
      if (document.hidden) return;
      try { const value = environmentInspection.parse(await api('/api/tools/inspect_environment',{path:checkout.path})); if (active) { setInspection(value); setError(''); } }
      catch(error) { if (active) setError(String(error)); }
    };
    void load(); const timer = window.setInterval(()=>void load(),5000);
    return ()=>{active=false;window.clearInterval(timer);};
  },[checkout.path]);
  const run = async(work:()=>Promise<unknown>)=>{
    setBusy(true); setError('');
    try { await work(); await refresh(); onChanged(); }
    catch(error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const controls = checkout.controls ?? [], disabled = busy || working;
  const edit = ()=>{ setDraft(JSON.stringify(inspection?.proposal ?? {version:1,services:[],previews:[]},null,2)); setTools(inspection?.tools ?? {}); setPreparationReview(false); setEditing(true); };
  const primary = inspection?.nextAction;
  const env = inspection?.environmentId?environments[inspection.environmentId]:checkout.environmentIds.map(id=>environments[id]).find(Boolean);
  const blocked = !!inspection?.blockers.length;
  return <PanelSection title="Environment">
    <label className="checkout-selector">Checkout<select value={checkout.path} onChange={e=>{setSelection(e.target.value);onSelect?.(e.target.value);}}>{checkouts.map(p=><option key={p.id} value={p.path}>{branchLabel(p)} · {p.path}</option>)}</select></label>
    <p className="mono runtime-meta">{checkout.path}{checkout.missing ? ' · directory unavailable' : ''}</p>
    {inspection && <p>{inspection.source ?? 'No saved configuration'}{inspection.proposal && (inspection.proposal as {restart?:string}).restart === 'on-failure' ? ' · Crash recovery: at most 3 starts within 60 seconds, with a 2-second retry delay' : ''}</p>}
    {error && <p className="notice bad" role="alert">{error}</p>}
    {inspection?.warnings.map((warning,i)=><p className="pv-note" key={i}>{warning}</p>)}
    {!!inspection?.blockers.length && <ul className="prerequisite-list">{inspection.blockers.map((b,i)=><li key={i}><strong>{b.code}</strong> · {b.message}</li>)}</ul>}
    {!!inspection?.requiredEnv.length && <p className="pv-note">Private environment files stay on the host with mode 0600. Only variable names and missing status are shown here.</p>}
    {inspection?.preparationError && <p role="alert">{inspection.preparationError.code} · {inspection.preparationError.message}</p>}
    {inspection?.preparationError?.code === 'PREPARATION_CLEANUP_REQUIRED' && inspection.preparationProgress && <button className="btn primary" disabled={disabled} onClick={()=>void run(()=>api(`/api/owner/preparation/${inspection.preparationProgress!.id}/cleanup`,{}))}>Verify preparation cleanup</button>}
    {inspection?.preparationStatus === 'running' && <p role="status">Preparation running in host systemd…</p>}
    {inspection?.preparationProgress && <p className="pv-note">Preparation step {inspection.preparationProgress.step}/{inspection.preparationProgress.total} · {inspection.preparationStatus}<br/><span className="mono">{inspection.preparationProgress.unit}</span></p>}
    {!editing && <div className="environment-actions">
      {primary === 'Configure environment' && <button className="btn primary" disabled={disabled} onClick={edit}>Configure environment</button>}
      {primary === 'Review preparation' && <button className="btn primary" disabled={disabled || inspection?.preparationStatus === 'running'} onClick={()=>{setPreparationReview(true);setEditing(true);}}>Review preparation</button>}
      {primary === 'Review configuration' && <button className="btn primary" disabled={disabled || !inspection?.source} onClick={()=>onRequest(checkout.path)}>Review configuration</button>}
      {primary === 'Start' && <button className="btn primary" disabled={disabled || blocked} onClick={()=>env ? onAction(env.id,'start') : onRequest(checkout.path)}>Start</button>}
      {primary === 'Recover' && env && <button className="btn primary" disabled={disabled || blocked} onClick={()=>onAction(env.id,'recover')}>Recover</button>}
      {primary === 'Open' && env?.links[0] && <a className="btn primary" href={env.links[0].url} target="_blank" rel="noreferrer">Open</a>}
      {(primary === 'Retry observation' || (!inspection && !checkout.missing)) && <button className="btn" disabled={disabled} onClick={()=>void refresh()}>Retry observation</button>}
      {inspection?.source && !!inspection.proposal && <button className="btn" disabled={disabled} onClick={edit}>Review configuration details</button>}
    </div>}
    {editing && inspection && <div className="configuration-review">
      {!preparationReview && <>
        <label>Recipe JSON<textarea className="term recipe-editor" value={draft} onChange={e=>setDraft(e.target.value)} spellCheck={false}/></label>
        {(['node','python','venv'] as const).map(key=><label className="runtime-tool" key={key}>{key} path<input value={tools[key] ?? ''} onChange={e=>setTools({...tools,[key]:e.target.value})} placeholder="Automatic detection"/></label>)}
        <p className="pv-note">Save to private host state. Project-shared recipes remain authoritative. Saving grants no execution approval.</p>
        <button className="btn primary" disabled={disabled || inspection.preparationError?.code === 'PREPARATION_CLEANUP_REQUIRED'} onClick={()=>void run(async()=>{await api('/api/owner/configuration',{path:checkout.path,recipe:JSON.parse(draft),tools:Object.fromEntries(Object.entries(tools).filter(([,value])=>value)),fingerprint:inspection.fingerprint});setEditing(false);})}>Save configuration</button>
      </>}
      {!!inspection.preparation.length && <details open={primary === 'Review preparation'}><summary>Preparation · {inspection.preparationStatus}</summary>
        {inspection.preparation.map((step,i)=><div key={i} className="preparation-step"><pre className="term">{JSON.stringify(step.command,null,2)}</pre><p className="mono">{step.cwd}</p><p>Expected writes: {step.writes.join(', ')} · Lifecycle scripts: {step.lifecycleScripts ? 'may execute dependency build/install code' : 'no'} · Limit: {step.timeoutMs/1000}s</p></div>)}
        <p className="pv-note">This approval covers these exact commands, directories, expected writes and manifest/lockfile revisions. Installation jobs receive a clean environment without application secret values.</p>
        <details><summary>Manifest revisions and resolved tools</summary><pre className="term">{JSON.stringify({manifests:inspection.manifestRevisions,tools:inspection.tools},null,2)}</pre></details>
        <button className="btn primary" disabled={disabled || inspection.preparationStatus === 'running' || !inspection.source} onClick={()=>void run(async()=>{await api('/api/owner/preparation',{path:checkout.path,fingerprint:inspection.fingerprint,requestId:crypto.randomUUID()});setEditing(false);})}>Approve and run preparation</button>
      </details>}
      <button className="btn" onClick={()=>setEditing(false)}>Close review</button>
    </div>}
    {controls.map(control=>{const state=environments[control.id];return <div key={control.id} className="checkout-instance">
      <p className="mono">{branchLabel(checkout)} · {checkout.path} · {control.id}</p>
      {state?.services.map(service=><p className="pv-note" key={service.id}>{service.id}: {service.state}{service.restarts !== undefined ? ` · ${service.restarts} restart attempts` : ''}{service.result ? ` · ${service.result}` : ''}{service.exitCode !== undefined ? ` · exit ${service.exitCode}` : ''}</p>)}
      {state?.latestOperation?.error && <p role="alert">{state.latestOperation.error.code} · {state.latestOperation.error.message}</p>}
      <div className="environment-actions">
        {(control.hasResources || control.desiredState === 'running') && <button className="btn" disabled={disabled} onClick={()=>onAction(control.id,'stop')}>Stop</button>}
        {!control.hasResources && control.desiredState === 'stopped' && control.startAllowed && (control.id!==env?.id || primary!=='Start') && <button className="btn" disabled={disabled} onClick={()=>onAction(control.id,'start')}>Start {control.id}</button>}
        {!control.hasResources && control.desiredState === 'stopped' && control.kind==='instance' && <button className="btn" disabled={disabled} onClick={()=>{if(window.confirm(`Retire ${control.id} at ${checkout.path}? Release its verified-clean allocations and retain operation history.`))void run(()=>api('/api/owner/retirement',{environmentId:control.id}));}}>Retire instance…</button>}
        {state && <label className="recovery-choice"><input type="checkbox" checked={!!state.restoreAfterReboot} disabled={disabled || (!control.startAllowed && !state.restoreAfterReboot)} onChange={e=>void run(()=>api('/api/owner/recovery-policy',{environmentId:control.id,restore:e.target.checked}))}/>Restore this previously running checkout after reboot</label>}
      </div>
      {!!state?.restorationAttempts && <p className="pv-note">Reboot restoration attempts: {state.restorationAttempts}/3. Stop cancels restoration.</p>}
    </div>;})}
    {inspection?.source && !!inspection.proposal && <button className="btn ghost" onClick={()=>void run(async()=>{const {recipe}=await api('/api/owner/export-recipe',{path:checkout.path});const url=URL.createObjectURL(new Blob([JSON.stringify(recipe,null,2)+'\n'],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download='.rootlane.json';link.click();URL.revokeObjectURL(url);})}>Export recipe</button>}
  </PanelSection>;
}
