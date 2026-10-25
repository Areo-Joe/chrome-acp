import { RequestError, methods, type AnyMessage, type JsonRpcId } from "@agentclientprotocol/sdk";

interface Session {
  cwd: string;
  active: boolean;
  pending: Set<JsonRpcId>;
  parent?: Session;
}

interface Pending {
  method: string;
  sessionId?: string;
  cwd: string;
  session?: Session;
  subagents?: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Observe lifecycle boundaries without translating ACP messages or results. */
export class LocalSessions {
  private initialized = false;
  private acceptsSubagents = false;
  private readonly sessions = new Map<string, Session>();
  private readonly requests = new Map<JsonRpcId, Pending>();

  constructor(private readonly cwd: string, private readonly release: (sessionId: string) => void) {}

  require(sessionId: string): string {
    const session = this.initialized ? this.sessions.get(sessionId) : undefined;
    if (!session) throw RequestError.internalError(`unknown session: ${sessionId}`);
    return session.cwd;
  }

  sent(message: AnyMessage): void {
    if (!("method" in message) || !("id" in message)) return;
    const method = message.method;
    if (!this.initialized && method !== methods.agent.initialize) return;
    const lifecycle: string[] = [methods.agent.initialize, methods.agent.session.new,
      methods.agent.session.load, methods.agent.session.resume, methods.agent.session.fork,
      methods.agent.session.close];
    if (!lifecycle.includes(method)) return;
    const params = object(message.params) ? message.params : {};
    const sessionId = typeof params.sessionId === "string" ? params.sessionId : undefined;
    const cwd = typeof params.cwd === "string" ? params.cwd : this.cwd;
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (this.initialized && sessionId &&
        (method === methods.agent.session.load || method === methods.agent.session.resume)) {
      // Zed registers a loading session before dispatch, so requests emitted
      // during history replay can resolve their session. Failed loads roll back.
      if (!session) {
        session = { cwd, active: false, pending: new Set() };
        this.sessions.set(sessionId, session);
      }
      session.pending.add(message.id);
    }
    const capabilities = object(params.clientCapabilities) ? params.clientCapabilities : {};
    this.requests.set(message.id, {
      method, sessionId, cwd, session, subagents: object(capabilities.subagents),
    });
  }

  received(message: AnyMessage): void {
    if ("method" in message) {
      if (this.acceptsSubagents && message.method === methods.client.session.update && object(message.params)) {
        const parent = this.sessions.get(message.params.sessionId as string);
        const update = message.params.update;
        if (parent && object(update) && update.sessionUpdate === "subagent_update" &&
            typeof update.sessionId === "string" && !this.sessions.has(update.sessionId)) {
          this.sessions.set(update.sessionId, {
            cwd: parent.cwd, active: true, pending: new Set(), parent,
          });
        }
      }
      return;
    }
    const pending = this.requests.get(message.id);
    if (!pending) return;
    this.requests.delete(message.id);
    const { method, sessionId, session, cwd } = pending;
    const success = "result" in message;
    if (method === methods.agent.initialize) {
      if (success) {
        this.initialized = true;
        this.acceptsSubagents = pending.subagents ?? false;
      }
      return;
    }
    if (method === methods.agent.session.new || method === methods.agent.session.fork) {
      if (success && object(message.result) && typeof message.result.sessionId === "string") {
        const id = message.result.sessionId;
        this.sessions.set(id, { cwd, active: true, pending: new Set() });
      }
    } else if (sessionId && session && this.sessions.get(sessionId) === session) {
      if (method === methods.agent.session.load || method === methods.agent.session.resume) {
        session.pending.delete(message.id);
        if (success) {
          session.active = true;
          session.cwd = cwd;
        } else if (!session.active && session.pending.size === 0) {
          this.remove(sessionId, session);
        }
      } else if (success) {
        this.remove(sessionId, session);
      }
    }
  }

  private remove(id: string, session: Session): void {
    for (const [childId, child] of this.sessions) {
      if (child.parent === session) this.remove(childId, child);
    }
    this.sessions.delete(id);
    this.release(id);
  }

  clear(): void {
    this.initialized = false;
    this.acceptsSubagents = false;
    this.sessions.clear();
    this.requests.clear();
  }
}
