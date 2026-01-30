import { useState, useEffect, useCallback } from "react";
import type { ACPClient } from "../acp/client";
import type { SessionUpdate, ToolCallContent, PermissionRequestPayload, PermissionOption } from "../acp/types";

// AI Elements components
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "./ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "./ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  type PromptInputMessage,
} from "./ai-elements/prompt-input";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "./ai-elements/tool";
import { Shimmer } from "./ai-elements/shimmer";
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "./ai-elements/reasoning";
import { ToolPermissionButtons } from "./ai-elements/permission-request";

// =============================================================================
// Type Definitions - Flat Entry Structure (matching Zed's architecture)
// =============================================================================

// Tool call status (matches Zed's ToolCallStatus enum)
type ToolCallStatus = "running" | "complete" | "error" | "waiting_for_confirmation" | "rejected" | "canceled";

// Tool call data
interface ToolCallData {
  id: string;
  title: string;
  status: ToolCallStatus;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
  // Permission request data (only when status is "waiting_for_confirmation")
  permissionRequest?: {
    requestId: string;
    options: PermissionOption[];
  };
  // True if this is a standalone permission request (not attached to a real tool call)
  isStandalonePermission?: boolean;
}

// Assistant message chunk - can be regular message or thought
type AssistantChunk =
  | { type: "message"; text: string }
  | { type: "thought"; text: string };

// User message entry
interface UserMessageEntry {
  type: "user_message";
  id: string;
  content: string;
}

// Assistant message entry - contains chunks (text + thoughts)
interface AssistantMessageEntry {
  type: "assistant_message";
  id: string;
  chunks: AssistantChunk[];
}

// Tool call entry - standalone, not nested in messages
interface ToolCallEntry {
  type: "tool_call";
  toolCall: ToolCallData;
}

// Thread entry - flat list of all entries
type ThreadEntry = UserMessageEntry | AssistantMessageEntry | ToolCallEntry;

interface ChatInterfaceProps {
  client: ACPClient;
}

// Helper to format tool call content for display
function formatToolOutput(
  content?: ToolCallContent[],
  rawOutput?: Record<string, unknown>,
): unknown {
  // First try to extract from structured content
  if (content && content.length > 0) {
    const results: string[] = [];

    for (const item of content) {
      if (item.type === "content") {
        if (item.content.type === "text" && item.content.text) {
          results.push(item.content.text);
        }
      } else if (item.type === "diff") {
        results.push(`📝 ${item.path}\n--- Old\n+++ New\n${item.newText}`);
      } else if (item.type === "terminal") {
        results.push(`🖥️ Terminal: ${item.terminalId}`);
      }
    }

    if (results.length > 0) {
      return results.length === 1 ? results[0] : results.join("\n\n");
    }
  }

  // Fall back to rawOutput if content didn't produce results
  if (rawOutput && Object.keys(rawOutput).length > 0) {
    return rawOutput;
  }

  return null;
}

// =============================================================================
// Helper Functions
// =============================================================================

// Map ACP status string to our status type
function mapToolStatus(status: string): ToolCallStatus {
  if (status === "completed") return "complete";
  if (status === "failed") return "error";
  return "running";
}

// Find tool call index in entries (search from end, like Zed)
function findToolCallIndex(entries: ThreadEntry[], toolCallId: string): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry && entry.type === "tool_call" && entry.toolCall.id === toolCallId) {
      return i;
    }
  }
  return -1;
}

// =============================================================================
// ChatInterface Component
// =============================================================================

export function ChatInterface({ client }: ChatInterfaceProps) {
  // Flat list of entries (like Zed's entries: Vec<AgentThreadEntry>)
  const [entries, setEntries] = useState<ThreadEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // =============================================================================
  // Permission Request Handler
  // =============================================================================
  const handlePermissionRequest = useCallback((request: PermissionRequestPayload) => {
    console.log("[ChatInterface] Permission request:", request);

    setEntries((prev) => {
      // Find matching tool call (search from end)
      const toolCallIndex = findToolCallIndex(prev, request.toolCall.toolCallId);

      if (toolCallIndex >= 0) {
        // Update existing tool call's status
        return prev.map((entry, index) => {
          if (index !== toolCallIndex) return entry;
          if (entry.type !== "tool_call") return entry;
          if (entry.toolCall.status !== "running") return entry;

          return {
            type: "tool_call",
            toolCall: {
              ...entry.toolCall,
              status: "waiting_for_confirmation" as const,
              permissionRequest: {
                requestId: request.requestId,
                options: request.options,
              },
            },
          };
        });
      } else {
        // No matching tool call - create standalone permission request as new entry
        console.log("[ChatInterface] No matching tool call, creating standalone permission request");

        const permissionToolCall: ToolCallEntry = {
          type: "tool_call",
          toolCall: {
            id: request.toolCall.toolCallId,
            title: request.toolCall.title || "Permission Request",
            status: "waiting_for_confirmation",
            permissionRequest: {
              requestId: request.requestId,
              options: request.options,
            },
            isStandalonePermission: true,
          },
        };

        return [...prev, permissionToolCall];
      }
    });
  }, []);

  // =============================================================================
  // Session Update Handler (Zed-style: check last entry type)
  // =============================================================================
  const handleSessionUpdate = useCallback((update: SessionUpdate) => {
    // Handle agent message chunk
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content.type === "text" && update.content.text ? update.content.text : "";
      if (!text) return;

      setEntries((prev) => {
        const lastEntry = prev[prev.length - 1];

        // If last entry is AssistantMessage, append to it
        if (lastEntry?.type === "assistant_message") {
          const lastChunk = lastEntry.chunks[lastEntry.chunks.length - 1];

          // If last chunk is same type (message), append text
          if (lastChunk?.type === "message") {
            return [
              ...prev.slice(0, -1),
              {
                ...lastEntry,
                chunks: [
                  ...lastEntry.chunks.slice(0, -1),
                  { type: "message", text: lastChunk.text + text },
                ],
              },
            ];
          }

          // Otherwise add new message chunk
          return [
            ...prev.slice(0, -1),
            {
              ...lastEntry,
              chunks: [...lastEntry.chunks, { type: "message", text }],
            },
          ];
        }

        // Create new AssistantMessage entry
        const newEntry: AssistantMessageEntry = {
          type: "assistant_message",
          id: `assistant-${Date.now()}`,
          chunks: [{ type: "message", text }],
        };
        return [...prev, newEntry];
      });
    }
    // Handle agent thought chunk (NEW - was missing before)
    else if (update.sessionUpdate === "agent_thought_chunk") {
      const text = update.content.type === "text" && update.content.text ? update.content.text : "";
      if (!text) return;

      setEntries((prev) => {
        const lastEntry = prev[prev.length - 1];

        // If last entry is AssistantMessage, append to it
        if (lastEntry?.type === "assistant_message") {
          const lastChunk = lastEntry.chunks[lastEntry.chunks.length - 1];

          // If last chunk is same type (thought), append text
          if (lastChunk?.type === "thought") {
            return [
              ...prev.slice(0, -1),
              {
                ...lastEntry,
                chunks: [
                  ...lastEntry.chunks.slice(0, -1),
                  { type: "thought", text: lastChunk.text + text },
                ],
              },
            ];
          }

          // Otherwise add new thought chunk
          return [
            ...prev.slice(0, -1),
            {
              ...lastEntry,
              chunks: [...lastEntry.chunks, { type: "thought", text }],
            },
          ];
        }

        // Create new AssistantMessage entry with thought
        const newEntry: AssistantMessageEntry = {
          type: "assistant_message",
          id: `assistant-${Date.now()}`,
          chunks: [{ type: "thought", text }],
        };
        return [...prev, newEntry];
      });
    }
    // Handle user message chunk (NEW - was missing before)
    else if (update.sessionUpdate === "user_message_chunk") {
      const text = update.content.type === "text" && update.content.text ? update.content.text : "";
      if (!text) return;

      setEntries((prev) => {
        const lastEntry = prev[prev.length - 1];

        // If last entry is UserMessage, append to it
        if (lastEntry?.type === "user_message") {
          return [
            ...prev.slice(0, -1),
            {
              ...lastEntry,
              content: lastEntry.content + text,
            },
          ];
        }

        // Create new UserMessage entry
        const newEntry: UserMessageEntry = {
          type: "user_message",
          id: `user-${Date.now()}`,
          content: text,
        };
        return [...prev, newEntry];
      });
    }
    // Handle tool call (UPSERT - update if exists, create if not)
    else if (update.sessionUpdate === "tool_call") {
      const toolCallData: ToolCallData = {
        id: update.toolCallId,
        title: update.title,
        status: mapToolStatus(update.status),
        content: update.content,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      };

      setEntries((prev) => {
        // UPSERT: Check if tool call already exists
        const existingIndex = findToolCallIndex(prev, update.toolCallId);

        if (existingIndex >= 0) {
          // UPDATE existing tool call
          return prev.map((entry, index) => {
            if (index !== existingIndex) return entry;
            if (entry.type !== "tool_call") return entry;

            return {
              type: "tool_call",
              toolCall: {
                ...entry.toolCall,
                ...toolCallData,
              },
            };
          });
        }

        // CREATE new tool call entry
        const newEntry: ToolCallEntry = {
          type: "tool_call",
          toolCall: toolCallData,
        };
        return [...prev, newEntry];
      });
    }
    // Handle tool call update (partial update)
    else if (update.sessionUpdate === "tool_call_update") {
      setEntries((prev) => {
        const existingIndex = findToolCallIndex(prev, update.toolCallId);

        if (existingIndex < 0) {
          // Tool call not found - create a failed tool call entry (like Zed)
          console.warn(`[ChatInterface] Tool call not found for update: ${update.toolCallId}`);
          const failedEntry: ToolCallEntry = {
            type: "tool_call",
            toolCall: {
              id: update.toolCallId,
              title: update.title || "Tool call not found",
              status: "error",
              content: [{ type: "content", content: { type: "text", text: "Tool call not found" } }],
            },
          };
          return [...prev, failedEntry];
        }

        return prev.map((entry, index) => {
          if (index !== existingIndex) return entry;
          if (entry.type !== "tool_call") return entry;

          const newStatus = update.status ? mapToolStatus(update.status) : entry.toolCall.status;
          const mergedContent = update.content
            ? [...(entry.toolCall.content || []), ...update.content]
            : entry.toolCall.content;

          return {
            type: "tool_call",
            toolCall: {
              ...entry.toolCall,
              status: newStatus,
              ...(update.title && { title: update.title }),
              content: mergedContent,
              ...(update.rawInput && { rawInput: update.rawInput }),
              ...(update.rawOutput && { rawOutput: update.rawOutput }),
            },
          };
        });
      });
    }
  }, []);

  // =============================================================================
  // Setup Effect
  // =============================================================================
  useEffect(() => {
    client.setSessionCreatedHandler((sessionId) => {
      console.log("[ChatInterface] Session created:", sessionId);
      setSessionReady(true);
    });

    client.setSessionUpdateHandler((update: SessionUpdate) => {
      handleSessionUpdate(update);
    });

    client.setPromptCompleteHandler((stopReason) => {
      console.log("[ChatInterface] Prompt complete:", stopReason);
      // Always set isLoading=false when prompt completes
      // This includes stopReason="cancelled" (which is the expected response after client.cancel())
      // Note: Tool calls are already marked as "canceled" in handleCancel before this fires
      setIsLoading(false);
    });

    client.setPermissionRequestHandler(handlePermissionRequest);

    // Create session
    client.createSession();
  }, [client, handlePermissionRequest, handleSessionUpdate]);

  // =============================================================================
  // User Actions
  // =============================================================================
  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || isLoading || !sessionReady) return;

    // Add user message as new entry
    const userEntry: UserMessageEntry = {
      type: "user_message",
      id: `user-${Date.now()}`,
      content: text,
    };
    setEntries((prev) => [...prev, userEntry]);
    setIsLoading(true);

    try {
      await client.sendPrompt(text);
    } catch (error) {
      console.error("[ChatInterface] Failed to send prompt:", error);
      setIsLoading(false);
    }
  };

  // Cancel handler - matches Zed's cancel() logic in acp_thread.rs
  // 1. Mark all pending/running/waiting_for_confirmation tool calls as canceled
  // 2. Send cancel notification to agent
  // 3. Do NOT set isLoading=false here - wait for prompt_complete with stopReason="cancelled"
  const handleCancel = () => {
    console.log("[ChatInterface] Cancel requested");

    // Like Zed: iterate all entries, mark Pending/WaitingForConfirmation/InProgress tool calls as Canceled
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.type !== "tool_call") return entry;

        // Check if status should be canceled (matches Zed's logic)
        const shouldCancel =
          entry.toolCall.status === "running" ||
          entry.toolCall.status === "waiting_for_confirmation";

        if (!shouldCancel) return entry;

        console.log("[ChatInterface] Marking tool call as canceled:", entry.toolCall.id);
        return {
          type: "tool_call",
          toolCall: {
            ...entry.toolCall,
            status: "canceled" as ToolCallStatus,
            permissionRequest: undefined, // Clear any pending permission request
          },
        };
      }),
    );

    // Send cancel notification to server (which forwards to agent)
    client.cancel();
    // Note: Do NOT set isLoading=false here!
    // Wait for prompt_complete with stopReason="cancelled" from the agent
  };

  const handlePermissionResponse = useCallback((requestId: string, optionId: string | null, optionKind: PermissionOption["kind"] | null) => {
    console.log("[ChatInterface] Permission response:", { requestId, optionId, optionKind });
    client.respondToPermission(requestId, optionId);

    // Determine new status based on option kind
    const isRejected = optionKind === "reject_once" || optionKind === "reject_always" || optionId === null;

    // Update the tool call status in entries
    setEntries((prev) =>
      prev.map((entry) => {
        if (entry.type !== "tool_call") return entry;
        if (entry.toolCall.permissionRequest?.requestId !== requestId) return entry;

        // For standalone permission requests, mark as complete immediately when approved
        // For regular tool calls, mark as running (agent will update to complete later)
        let newStatus: ToolCallStatus;
        if (isRejected) {
          newStatus = "rejected";
        } else if (entry.toolCall.isStandalonePermission) {
          newStatus = "complete";
        } else {
          newStatus = "running";
        }

        return {
          type: "tool_call",
          toolCall: {
            ...entry.toolCall,
            status: newStatus,
            permissionRequest: undefined,
            isStandalonePermission: undefined,
          },
        };
      }),
    );
  }, [client]);

  // =============================================================================
  // Render Helpers
  // =============================================================================

  // Map tool status to UI state
  const getToolState = (status: ToolCallStatus) => {
    switch (status) {
      case "error":
        return "output-error" as const;
      case "running":
        return "input-available" as const;
      case "waiting_for_confirmation":
        return "waiting-for-confirmation" as const;
      case "rejected":
        return "rejected" as const;
      case "canceled":
        return "output-error" as const; // Show canceled as error state
      case "complete":
      default:
        return "output-available" as const;
    }
  };

  // Render a tool call entry
  const renderToolCall = (entry: ToolCallEntry) => {
    const tool = entry.toolCall;
    const toolOutput = formatToolOutput(tool.content, tool.rawOutput);
    const hasOutput =
      tool.status !== "running" && tool.status !== "waiting_for_confirmation" && toolOutput !== null;

    return (
      <Tool
        key={tool.id}
        defaultOpen={hasOutput || tool.status === "waiting_for_confirmation"}
        className={tool.status === "rejected" ? "border-dashed border-orange-500/50" : undefined}
      >
        <ToolHeader
          title={tool.title}
          type="tool-invocation"
          state={getToolState(tool.status)}
        />
        <ToolContent>
          {tool.rawInput && <ToolInput input={tool.rawInput} />}
          {/* Show permission buttons when waiting for confirmation */}
          {tool.status === "waiting_for_confirmation" && tool.permissionRequest && (
            <ToolPermissionButtons
              requestId={tool.permissionRequest.requestId}
              options={tool.permissionRequest.options}
              onRespond={handlePermissionResponse}
            />
          )}
          {/* Show output for completed/error states */}
          {tool.status !== "waiting_for_confirmation" && tool.status !== "rejected" && (
            <ToolOutput
              output={toolOutput}
              errorText={tool.status === "error" ? "Tool execution failed" : undefined}
            />
          )}
        </ToolContent>
      </Tool>
    );
  };

  // Check if we should show thinking indicator
  const showThinkingIndicator = isLoading && entries.length > 0 &&
    entries[entries.length - 1]?.type === "user_message";

  const chatStatus = isLoading ? "streaming" : "ready";

  // =============================================================================
  // Render
  // =============================================================================
  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <Conversation className="flex-1">
        <ConversationContent>
          {!sessionReady ? (
            <div className="flex items-center justify-center p-4">
              <Shimmer>Creating session...</Shimmer>
            </div>
          ) : entries.length === 0 ? (
            <ConversationEmptyState
              title="Start a conversation"
              description="Type a message below to chat with the ACP agent"
            />
          ) : (
            <>
              {entries.map((entry, index) => {
                // Render UserMessage
                if (entry.type === "user_message") {
                  return (
                    <Message key={entry.id} from="user">
                      <MessageContent>
                        <MessageResponse>{entry.content}</MessageResponse>
                      </MessageContent>
                    </Message>
                  );
                }

                // Render AssistantMessage (with chunks)
                if (entry.type === "assistant_message") {
                  return (
                    <Message key={entry.id} from="assistant">
                      <MessageContent>
                        {entry.chunks.map((chunk, chunkIndex) => {
                          if (chunk.type === "thought") {
                            // Determine if this thought chunk is still streaming
                            const isLastChunk = chunkIndex === entry.chunks.length - 1;
                            const isThoughtStreaming = isLoading && isLastChunk;
                            return (
                              <Reasoning
                                key={chunkIndex}
                                isStreaming={isThoughtStreaming}
                              >
                                <ReasoningTrigger />
                                <ReasoningContent>
                                  <MessageResponse>{chunk.text}</MessageResponse>
                                </ReasoningContent>
                              </Reasoning>
                            );
                          }
                          // Regular message chunk
                          return <MessageResponse key={chunkIndex}>{chunk.text}</MessageResponse>;
                        })}
                      </MessageContent>
                    </Message>
                  );
                }

                // Render ToolCall (standalone entry)
                if (entry.type === "tool_call") {
                  return (
                    <Message key={entry.toolCall.id} from="assistant">
                      <MessageContent>
                        {renderToolCall(entry)}
                      </MessageContent>
                    </Message>
                  );
                }

                return null;
              })}

              {/* Thinking indicator - show when loading after user message */}
              {showThinkingIndicator && (
                <Message from="assistant">
                  <MessageContent>
                    <Shimmer>Thinking...</Shimmer>
                  </MessageContent>
                </Message>
              )}
            </>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {/* Input area */}
      <div className="border-t p-4">
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputTextarea
            placeholder={sessionReady ? "Type a message..." : "Waiting for session..."}
            disabled={!sessionReady}
          />
          <PromptInputFooter>
            <div /> {/* Spacer */}
            <PromptInputSubmit
              status={chatStatus}
              disabled={!sessionReady}
              onClick={isLoading ? handleCancel : undefined}
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}

