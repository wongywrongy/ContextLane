import React, { useState } from 'react';

function Command({ title, children }: { title: string; children: string }) {
  const [notice, setNotice] = useState('');
  return <div className="setup-command"><div className="toolbar"><span>{title}</span><button onClick={async () => {
    try { await navigator.clipboard.writeText(children); setNotice('Copied'); }
    catch { setNotice('Copy unavailable. Select and copy the text below.'); }
  }} aria-label={`Copy ${title}`}>Copy</button></div><pre><code>{children}</code></pre><span className="muted" role="status">{notice}</span></div>;
}

export function McpSetup() {
  return <div className="mcp-setup">
    <h2>Connect your coding tools</h2>
    <p>Rootlane’s MCP adapter lets Codex and Claude Code discover projects and operate reviewed environments using the same backend as this page.</p>
    <section><h3>Before you start</h3>
      <p>Run these commands on <strong>the Rootlane host</strong>, as the installation owner, where your coding client runs. They use an example Docker installation at <code>/opt/stacks/rootlane</code>. If you installed elsewhere, replace that absolute path in the examples.</p>
      <Command title="Check the installation">{`test -x /opt/stacks/rootlane/deploy/rootlane-mcp-docker && echo "Adapter found"
docker compose --project-directory /opt/stacks/rootlane ps`}</Command>
      <p>The Rootlane container must be running and your user must have Docker access. The adapter reads its separate agent credential inside that container; do not paste your browser credential or an agent token into client configuration.</p>
    </section>
    <section><h3>Codex</h3>
      <p>Register the installed adapter, then restart your Codex session.</p>
      <Command title="Register with Codex">{'codex mcp add rootlane -- /opt/stacks/rootlane/deploy/rootlane-mcp-docker'}</Command>
      <p>In <code>~/.codex/config.toml</code>, merge these settings into the existing <code>[mcp_servers.rootlane]</code> entry. Keep a single entry; retain your other configuration.</p>
      <Command title="Codex tool policy">{`[mcp_servers.rootlane]
command = "/opt/stacks/rootlane/deploy/rootlane-mcp-docker"
enabled_tools = ["list_projects", "get_environment", "start_environment", "stop_environment", "get_logs"]
startup_timeout_sec = 10
tool_timeout_sec = 15
default_tools_approval_mode = "prompt"`}</Command>
      <p>Use <code>/mcp</code> inside Codex to inspect the connection. Keep normal tool approvals; backend ownership checks still apply.</p>
      <a href="https://developers.openai.com/codex/mcp" target="_blank" rel="noreferrer">Official Codex MCP documentation</a>
    </section>
    <section><h3>Claude Code</h3>
      <p>Register in user scope to make Rootlane available across your projects on this host, then restart your Claude Code session.</p>
      <Command title="Register with Claude Code">{'claude mcp add --transport stdio --scope user rootlane -- /opt/stacks/rootlane/deploy/rootlane-mcp-docker'}</Command>
      <p>Use <code>/mcp</code> inside Claude Code to check the connection and review tool permissions. If Rootlane is already registered, inspect that entry first; avoid competing local, project and user definitions.</p>
      <a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noreferrer">Official Claude Code MCP documentation</a>
    </section>
    <section><h3>Verify a real tool call</h3>
      <p>In a new coding session, ask:</p>
      <Command title="Read-only verification prompt">{'Use Rootlane’s list_projects tool to list my projects. Do not start or stop anything.'}</Command>
      <p>A successful result contains your actual project catalog. Seeing a saved server entry alone does not verify a working connection.</p>
      <dl className="mcp-tools"><dt><code>list_projects</code></dt><dd>Discover projects, worktrees and known links.</dd><dt><code>get_environment</code></dt><dd>Read current environment status and its latest operation.</dd><dt><code>start_environment</code></dt><dd>Start an owner-reviewed profile by ID and request ID.</dd><dt><code>stop_environment</code></dt><dd>Stop Rootlane-owned resources by ID and request ID.</dd><dt><code>get_logs</code></dt><dd>Read bounded logs for a Rootlane-owned service.</dd></dl>
      <p>Existing projects remain observe-only. Start and stop require a reviewed profile; accepting an operation does not mean the application is ready.</p>
    </section>
    <section><h3>If it does not connect</h3>
      <ul><li><strong>Adapter missing:</strong> check the installation path and that the wrapper is executable.</li><li><strong>Docker unavailable or permission denied:</strong> check Docker access as the installation owner.</li><li><strong>Rootlane unavailable:</strong> check the container status and retry after the backend is healthy. The adapter never starts another backend.</li><li><strong>Unauthorized:</strong> check the private agent credential file and container configuration on the Rootlane host. Keep its contents private.</li><li><strong>Tools missing:</strong> restart the coding session and inspect its MCP entry and tool permissions.</li></ul>
      <p>This setup uses local stdio. Rootlane does not currently expose a remote <code>/mcp</code> endpoint; the browser URL cannot be used as an MCP server URL from another device.</p>
    </section>
  </div>;
}
