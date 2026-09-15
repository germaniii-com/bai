import { useState, type FormEvent } from "react";
import type { BaiClient } from "@bai/api/client";
import type { MCPServerConfig, McpTransport, McpServerSource } from "@bai/shared";
import { Button, Field, Modal, Select, Textarea, TextInput, ToggleRow } from "./components";

const TRANSPORT_OPTIONS: { value: McpTransport; label: string }[] = [
  { value: "stdio", label: "stdio — spawn a local process" },
  { value: "http", label: "HTTP — remote streamable HTTP" },
  { value: "sse", label: "SSE — remote server-sent events" },
];

/** Non-empty, trimmed lines (args). */
function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Parse `KEY=VALUE` / `KEY: VALUE` / `KEY:VALUE` lines into a record. */
function keyValues(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of lines(text)) {
    const match = /^([^:=]+)[:=](.*)$/.exec(line);
    if (match === null) continue;
    out[match[1]!.trim()] = match[2]!.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

const inbound = {
  args: (config?: MCPServerConfig): string => (config?.args ?? []).join("\n"),
  env: (config?: MCPServerConfig): string =>
    Object.entries(config?.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  headers: (config?: MCPServerConfig): string =>
    Object.entries(config?.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n"),
};

/**
 * Create/edit a custom MCP server. Writes a drop-in file under
 * ~/.config/bai/mcp/<name>.json (which overrides any same-named config.json
 * entry); the server hot-reloads and reconnects.
 */
export function McpServerModal({
  client,
  server,
  onClose,
  onSaved,
  onNotice,
}: {
  client: BaiClient;
  /** Existing server to edit; absent → create. */
  server?: { name: string; source: McpServerSource; config: MCPServerConfig };
  onClose: () => void;
  onSaved: () => void;
  onNotice: (message: string, kind?: "success" | "error") => void;
}) {
  const editing = server !== undefined;
  const config = server?.config;
  const [name, setName] = useState(server?.name ?? "");
  const [transport, setTransport] = useState<McpTransport>(config?.transport ?? (config?.url !== undefined ? "http" : "stdio"));
  const [command, setCommand] = useState(config?.command ?? "");
  const [args, setArgs] = useState(inbound.args(config));
  const [env, setEnv] = useState(inbound.env(config));
  const [cwd, setCwd] = useState(config?.cwd ?? "");
  const [url, setUrl] = useState(config?.url ?? "");
  const [headers, setHeaders] = useState(inbound.headers(config));
  const [oauth, setOauth] = useState(config?.oauth !== undefined && config.oauth !== false);
  const [enabled, setEnabled] = useState(config?.enabled !== false);
  const [timeout, setTimeout] = useState(config?.timeout !== undefined ? String(config.timeout) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const serverName = name.trim();
    if (serverName.length === 0) {
      setError("Server name is required");
      return;
    }
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(serverName)) {
      setError("Name must be a slug: start with a letter, then letters/digits/-/_");
      return;
    }
    const timeoutNum = timeout.trim().length > 0 ? Number(timeout) : undefined;
    if (timeoutNum !== undefined && (!Number.isFinite(timeoutNum) || timeoutNum <= 0)) {
      setError("Timeout must be a positive number of milliseconds");
      return;
    }
    const envMap = keyValues(env);
    const headerMap = keyValues(headers);
    const argsList = lines(args);
    let body: MCPServerConfig;
    if (transport === "stdio") {
      if (command.trim().length === 0) {
        setError("Command is required for a stdio server");
        return;
      }
      body = {
        transport: "stdio",
        command: command.trim(),
        ...(argsList.length > 0 ? { args: argsList } : {}),
        ...(envMap !== undefined ? { env: envMap } : {}),
        ...(cwd.trim().length > 0 ? { cwd: cwd.trim() } : {}),
        enabled,
        ...(timeoutNum !== undefined ? { timeout: timeoutNum } : {}),
      };
    } else {
      if (url.trim().length === 0) {
        setError("URL is required for an HTTP server");
        return;
      }
      body = {
        transport,
        url: url.trim(),
        ...(headerMap !== undefined ? { headers: headerMap } : {}),
        ...(oauth ? { oauth: true } : {}),
        enabled,
        ...(timeoutNum !== undefined ? { timeout: timeoutNum } : {}),
      };
    }
    void (async () => {
      setBusy(true);
      setError(null);
      try {
        await client.putMcpServer(serverName, body);
        onNotice(editing ? `Updated ${serverName}` : `Added MCP server ${serverName}`);
        onSaved();
        onClose();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={editing ? `Edit ${server?.name}` : "Add a custom MCP server"}
      size="md"
      footer={
        <Button variant="primary" onClick={submit} disabled={busy}>
          {editing ? "Save" : "Add server"}
        </Button>
      }
    >
      <form className="form-grid" onSubmit={submit}>
        <Field label="Name" hint="slug; becomes the mcp/<name>/ tool prefix">
          <TextInput value={name} placeholder="my-server" disabled={editing} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Transport">
          <Select
            options={TRANSPORT_OPTIONS}
            value={transport}
            onChange={(v) => setTransport(v as McpTransport)}
            ariaLabel="Transport"
          />
        </Field>
        {transport === "stdio" ? (
          <>
            <Field label="Command">
              <TextInput value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
            </Field>
            <Field label="Working directory" hint="optional">
              <TextInput value={cwd} placeholder="/path/to/dir" onChange={(e) => setCwd(e.target.value)} />
            </Field>
            <Field label="Arguments" hint="one per line">
              <Textarea value={args} mono rows={3} placeholder={"-y\n@some/mcp-server"} onChange={(e) => setArgs(e.target.value)} />
            </Field>
            <Field label="Environment" hint="one KEY=VALUE per line (${VAR} resolves from the shell env)">
              <Textarea value={env} mono rows={3} placeholder={"API_KEY=${MY_KEY}\nLOG_LEVEL=info"} onChange={(e) => setEnv(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <TextInput value={url} placeholder="https://mcp.example.com/mcp" onChange={(e) => setUrl(e.target.value)} />
            </Field>
            <Field label="Headers" hint="one KEY: VALUE per line (${VAR} resolves from the shell env)">
              <Textarea value={headers} mono rows={3} placeholder={"Authorization: Bearer ${TOKEN}"} onChange={(e) => setHeaders(e.target.value)} />
            </Field>
          </>
        )}
        <Field label="Timeout" hint="milliseconds (optional)">
          <TextInput value={timeout} inputMode="numeric" placeholder="30000" onChange={(e) => setTimeout(e.target.value)} />
        </Field>
      </form>
      <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.75rem" }}>
        {transport !== "stdio" && (
          <ToggleRow
            checked={oauth}
            onChange={setOauth}
            title="OAuth"
            description="Run the interactive OAuth flow on connect (instead of static headers)."
          />
        )}
        <ToggleRow
          checked={enabled}
          onChange={setEnabled}
          title="Enabled"
          description="Disabled servers are listed but never connected."
        />
        {error !== null && <p className="error">{error}</p>}
      </div>
    </Modal>
  );
}
