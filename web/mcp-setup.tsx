import React, { useState } from 'react';
import { toolContracts } from '../src/shared/contracts.js';
import { PanelSection, DetailRow } from './panel-section.js';
type ClientStatus = { client:'codex'|'claude';version:string|null;executable:string|null;configPath:string;adapter:string;adapterAvailable:boolean;configured:boolean;connectionChecked:boolean;toolCallVerified:boolean;tools:string[];missingTools?:string[];fingerprint:string;changes:string[];blockers:string[];telemetry?:{receiverAvailable:boolean;clientEventsReported:boolean;lastEventAt:string|null} };
export function McpSetup({api = async()=>{throw new Error('Unlock Rootlane to inspect host integrations');},telemetryEnabled=false,onChanged=()=>{}}:{api?:(path:string,body:unknown)=>Promise<any>;telemetryEnabled?:boolean;onChanged?:()=>void}) {
  const [client,setClient]=useState<'codex'|'claude'>('codex'),[status,setStatus]=useState<ClientStatus|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[telemetry,setTelemetry]=useState(false),[replace,setReplace]=useState(false);
  const run=async(action:'inspect'|'apply'|'verify')=>{
    setBusy(true);setError('');
    try {setStatus(await api('/api/owner/integrations',{client,action,telemetry,replaceExporters:replace,...(action==='apply' ? {fingerprint:status?.fingerprint} : {})}));onChanged();}
    catch(error){setError(String(error));}finally{setBusy(false);}
  };
  const receiver=async(enabled:boolean)=>{setBusy(true);setError('');try{await api('/api/owner/telemetry-policy',{enabled});onChanged();}catch(error){setError(String(error));}finally{setBusy(false);}};
  return <div className="mcp-setup"><h2>Connect your coding tools</h2><p>Inspect the installed client and adapter, review the proposed repair, then verify a read-only Rootlane call. Normal client approvals remain in effect.</p>
    <PanelSection title="Host client">
      <label className="client-selector">Client<select value={client} disabled={busy} onChange={e=>{setClient(e.target.value as 'codex'|'claude');setStatus(null);}}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>
      <label className="recovery-choice"><input type="checkbox" checked={telemetry} disabled={busy} onChange={e=>{setTelemetry(e.target.checked);setStatus(null);}}/>Include opt-in client telemetry setup</label>
      {telemetry && <><p className="pv-note">Receiver: {telemetryEnabled ? 'enabled' : 'disabled'}. Client event reporting is verified separately from receiver availability and synthetic ingestion.</p>
      {!telemetryEnabled && <button className="btn" disabled={busy} onClick={()=>void receiver(true)}>Enable counts-only telemetry receiver</button>}
      <label className="recovery-choice"><input type="checkbox" checked={replace} onChange={e=>{setReplace(e.target.checked);setStatus(null);}}/>Review replacement of this client’s existing telemetry exporter</label></>}
      <button className="btn primary" disabled={busy || (telemetry && !telemetryEnabled)} onClick={()=>void run('inspect')}>{busy ? 'Checking host…' : 'Inspect integration'}</button>
      {error && <p className="notice bad" role="alert">{error}</p>}
      {status && <>
        <div className="integration-status" role="status">
        <DetailRow label="Configured" value={status.configured ? 'Yes' : 'No'}/><DetailRow label="Connection checked" value={status.connectionChecked ? 'Yes' : 'Not checked'}/><DetailRow label="Tool call verified" value={status.toolCallVerified ? 'Yes' : 'Not verified'}/>
        </div>
        {telemetry && status.telemetry && <><DetailRow label="Receiver available" value={status.telemetry.receiverAvailable?'Yes':'No'}/><DetailRow label="Client events" value={status.telemetry.clientEventsReported?'Reported':'Not observed'}/></>}
        {!!status.missingTools?.length && <DetailRow label="Missing tools" value={status.missingTools.join(', ')}/>}
        {status.blockers.map((text,i)=><p className="notice" key={i}>{text}</p>)}
        <details className="disclosure repair-review"><summary>Review repair <span>{status.changes.length} proposed changes</span></summary><ol>{status.changes.map((text,i)=><li key={i}><pre className="repair-change">{text}</pre></li>)}</ol><p className="pv-note">Repairs preserve unrelated permissions, hooks and existing status-line output. A concurrent settings change requires a new review. Agents cannot apply repairs.</p><button className="btn" disabled={busy || !!status.blockers.length} onClick={()=>void run('apply')}>Apply reviewed repair</button></details>
        <div className="environment-actions"><button className="btn" disabled={busy || !status.configured} onClick={()=>void run('verify')}>Check connection and read-only call</button></div>
        <details className="disclosure"><summary>Client details <span>{status.version ?? 'Unavailable'}</span></summary><DetailRow label="Executable" value={<code>{status.executable ?? 'Not found'}</code>}/><DetailRow label="Client settings" value={<code>{status.configPath}</code>}/><DetailRow label="Adapter" value={<code>{status.adapter}</code>} aside={status.adapterAvailable ? 'Found' : 'Missing'}/>{!!status.tools.length && <DetailRow label="Available tools" value={status.tools.join(', ')}/>}</details>
      </>}
    </PanelSection>
    <details className="disclosure"><summary>Verify from your client</summary><p>In a fresh Codex or Claude Code session, ask: Use Rootlane’s list_projects tool to list my projects. Do not start or stop anything.</p><p>Configured, Connection checked and Tool call verified are separate evidence. Claude’s CLI health check does not verify a tool call; use a real authenticated session. list_mcp_resources is not a connection test.</p><p>The installed local adapter connects to the existing backend. Rootlane does not currently expose a remote MCP endpoint.</p></details>
    <details className="disclosure"><summary>Rootlane tool reference <span>{Object.keys(toolContracts).length} tools</span></summary><div className="tbl-wrap" tabIndex={0} aria-label="MCP tools"><table className="tbl mcp-tools"><thead><tr><th>Tool</th><th>Access</th><th>Purpose</th></tr></thead><tbody>{Object.entries(toolContracts).map(([name,contract])=><tr key={name}><td data-label="Tool"><code>{name}</code></td><td data-label="Access">{contract.read ? 'Read' : 'Write'}</td><td data-label="Purpose">{contract.description}</td></tr>)}</tbody></table></div></details>
    {telemetryEnabled && <details className="disclosure maintenance"><summary>Telemetry maintenance</summary><p className="section-note">Disabling the receiver also deletes retained session counts. Existing client configuration stays in place.</p><button className="btn" disabled={busy} onClick={()=>{if(window.confirm('Disable the telemetry receiver and purge retained session counts? Existing client configuration stays in place.'))void receiver(false);}}>Disable receiver and purge counts…</button></details>}
  </div>;
}
