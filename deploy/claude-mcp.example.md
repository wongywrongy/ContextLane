Register the stdio server using [claude-mcp.example.json](claude-mcp.example.json), replacing the adapter path with your installed path. Keep normal tool approvals and existing client settings.

Review only these thirteen Rootlane tools in the client's MCP permissions: `list_projects`, `get_project`, `get_capabilities`, `get_environment`, `start_environment`, `stop_environment`, `get_logs`, `publish_preview`, `get_preview`, `unpublish_preview`, `locate`, `request_environment`, `list_operations`. Do not grant a blanket approval for mutating tools.

Call locate with your working directory first. For independent publication: check `get_capabilities {}`, discover a project with `list_projects`, identify its approved target with `get_project {projectId}`, start that fixture separately, and call `publish_preview {targetId, requestId}`. Inspect `get_preview {previewId}` for verified HTTPS, then remove the route with `unpublish_preview {previewId, requestId}`. Use caller-generated UUID request IDs and reuse them on identical retries. The application remains running after removal.

Discovery never grants publication approval. Installed client discovery and actual read-only calls establish connectivity; saved configuration alone does not. Preserve credential separation; the adapter reads its private agent token from the running installation.
