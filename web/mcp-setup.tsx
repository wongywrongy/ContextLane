import React, { useState } from 'react';
import { toolContracts } from '../src/shared/contracts.js';

function Command({ title, children }: { title: string; children: string }) {
  const [notice, setNotice] = useState('');
  return (
    <div className="setup-command">
      <div className="toolbar">
        <span>{title}</span>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(children);
              setNotice('Copied');
            } catch {
              setNotice('Copy unavailable. Select and copy the text below.');
            }
          }}
          aria-label={`Copy ${title}`}
        >
          {notice === 'Copied' ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre>
        <code>{children}</code>
      </pre>
      <span className="muted" role="status">
        {notice}
      </span>
    </div>
  );
}

export function McpSetup() {
  return (
    <div className="mcp-setup">
      <h2>Connect your coding tools</h2>
      <p>
        Rootlane’s MCP adapter lets Codex and Claude Code discover projects, publish approved running services and operate reviewed environments using
        the same backend as this page.
      </p>
      <section>
        <h3>1. Check the installation</h3>
        <p>
          Run these commands on <strong>the Rootlane host</strong>, as the installation owner, where your coding client runs. They use an example
          Docker installation at <code>/opt/stacks/rootlane</code>. If you installed elsewhere, replace that absolute path in the examples.
        </p>
        <Command title="Check the installation">{`test -x /opt/stacks/rootlane/deploy/rootlane-mcp-docker && echo "Adapter found"
docker compose --project-directory /opt/stacks/rootlane ps`}</Command>
        <p>
          The Rootlane container must be running and your user must have Docker access. The adapter reads its separate agent credential inside that
          container; do not paste your browser credential or an agent token into client configuration.
        </p>
      </section>
      <div className="mcp-clients">
        <section>
          <h3>2. Connect Codex</h3>
          <p>Register the installed adapter, then restart your Codex session.</p>
          <Command title="Register with Codex">{'codex mcp add rootlane -- /opt/stacks/rootlane/deploy/rootlane-mcp-docker'}</Command>
          <p>
            In <code>~/.codex/config.toml</code>, merge these settings into the existing <code>[mcp_servers.rootlane]</code> entry. Keep a single
            entry; retain your other configuration.
          </p>
          <Command title="Codex tool policy">{`[mcp_servers.rootlane]
command = "/opt/stacks/rootlane/deploy/rootlane-mcp-docker"
enabled_tools = ["list_projects", "get_environment", "start_environment", "stop_environment", "get_logs", "get_capabilities", "get_project", "publish_preview", "get_preview", "unpublish_preview", "locate", "request_environment", "list_operations"]
startup_timeout_sec = 10
tool_timeout_sec = 15
default_tools_approval_mode = "prompt"`}</Command>
          <p>
            Use <code>/mcp</code> inside Codex to inspect the connection. Keep normal tool approvals; backend ownership checks still apply.
          </p>
          <a href="https://developers.openai.com/codex/mcp" target="_blank" rel="noreferrer">
            Official Codex MCP documentation
          </a>
        </section>
        <section>
          <h3>2. Connect Claude Code</h3>
          <p>Register in user scope to make Rootlane available across your projects on this host, then restart your Claude Code session.</p>
          <Command title="Register with Claude Code">
            {'claude mcp add --transport stdio --scope user rootlane -- /opt/stacks/rootlane/deploy/rootlane-mcp-docker'}
          </Command>
          <p>
            Use <code>/mcp</code> inside Claude Code to check the connection and review tool permissions. If Rootlane is already registered, inspect
            that entry first; avoid competing local, project and user definitions.
          </p>
          <a href="https://code.claude.com/docs/en/mcp" target="_blank" rel="noreferrer">
            Official Claude Code MCP documentation
          </a>
        </section>
      </div>
      <section>
        <h3>Prefer agent-assisted setup?</h3>
        <p>
          Paste this optional prompt into Codex or Claude Code running on the Rootlane host. It asks the agent to use the same registration commands
          above. Client permissions or a fresh session may still be required.
        </p>
        <details>
          <summary>Show setup prompt</summary>
          <Command title="setup prompt">{`Connect this coding client to the existing Rootlane installation on this host. Locate its installed MCP adapter and inspect any existing rootlane registration before changing it. Use the client’s official registration command, preserving unrelated settings and normal approvals. For Codex, allow only list_projects, get_environment, start_environment, stop_environment, get_logs, get_capabilities, get_project, publish_preview, get_preview, unpublish_preview, locate, request_environment and list_operations.

Never print or copy credentials. Do not install another backend, upgrade software, change routes, or launch environments. If the installation is missing or inaccessible, report the blocker rather than replacing it.

Verify Rootlane with tools/list and a read-only locate call with your working directory. A list_mcp_resources result is not a tool-discovery check: Rootlane exposes tools, not resource entries. If this session has no Rootlane tools, report that limitation and give fresh-session or reconnect steps; do not claim setup succeeded from a saved registration or launcher text. Rootlane catalogs project links and reviewed local environments; it does not provide GitHub/Render API access or change public URLs or payment callbacks. Report exactly what changed.`}</Command>
        </details>
      </section>
      <section>
        <h3>3. Verify a real tool call</h3>
        <p>In a new coding session, ask:</p>
        <Command title="Read-only verification prompt">
          {'Use Rootlane’s list_projects tool to list my projects. Do not start or stop anything.'}
        </Command>
        <p>
          A successful result contains your actual project catalog. Seeing a saved server entry alone does not verify a working connection. Rootlane
          exposes tools, not resource entries; list_mcp_resources is not a connection test.
        </p>
        <div className="tbl-wrap" tabIndex={0} aria-label="MCP tools">
          <table className="tbl mcp-tools" role="table">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Access</th>
                <th scope="col">Purpose</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(toolContracts).map(([name, contract]) => (
                <tr key={name} role="row">
                  <td data-label="Tool" role="cell">
                    <code>{name}</code>
                  </td>
                  <td data-label="Access" role="cell">
                    <span className={`chip ${contract.read ? 'info' : 'warn'}`}>
                      <span aria-hidden="true">{contract.read ? '↗' : '!'}</span>
                      {contract.read ? 'Read' : 'Write'}
                    </span>
                  </td>
                  <td data-label="Purpose" role="cell">
                    {contract.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          Observe: locate with your absolute working directory, then get_project or get_environment as needed. Observation does not request approval
          or start anything.
        </p>
        <p>
          Publish a running service: locate → get_capabilities and identify an owner-approved target → publish_preview → poll get_preview.
          Publication and removal own only the route and leave the application running. A returned URL may still be unverified.
        </p>
        <p>
          Start a managed environment: locate → request_environment and owner approval at approvalUrl when required → start_environment → poll
          get_environment. An accepted operation does not mean the application is ready. Agents cannot approve or edit owner configuration.
        </p>
        <p>
          Start, stop, publish and unpublish return durable operations. Use list_operations for recent history. Keep the same UUID request ID and
          payload when retrying the same action; use a new UUID for a new action after resolving a failure.
        </p>
      </section>
      <section>
        <details className="mcp-troubleshooting">
          <summary>If it does not connect</summary>
          <ul>
            <li>
              <strong>Adapter missing:</strong> check the installation path and that the wrapper is executable.
            </li>
            <li>
              <strong>Docker unavailable or permission denied:</strong> check Docker access as the installation owner.
            </li>
            <li>
              <strong>Rootlane unavailable:</strong> check the container status and retry after the backend is healthy. The adapter never starts
              another backend.
            </li>
            <li>
              <strong>Unauthorized:</strong> check the private agent credential file and container configuration on the Rootlane host. Keep its
              contents private.
            </li>
            <li>
              <strong>Tools missing:</strong> use /mcp in the local coding client to inspect Rootlane connection errors and tool permissions, then
              reconnect or start a fresh session. A hosted chat may not expose your locally configured stdio tools.
            </li>
          </ul>
          <p>
            This setup uses local stdio. Rootlane does not currently expose a remote <code>/mcp</code> endpoint; the browser URL cannot be used as an
            MCP server URL from another device.
          </p>
        </details>
      </section>
    </div>
  );
}
