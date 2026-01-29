import { useState, useEffect, useCallback, useRef } from "react";
import type { ACPClient } from "@/acp/client";
import type { SessionUpdate, ToolCallContent } from "@/acp/types";

// AI Elements components
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@chrome-acp/shared/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@chrome-acp/shared/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  type PromptInputMessage,
} from "@chrome-acp/shared/components/ai-elements/prompt-input";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolInput,
  ToolOutput,
} from "@chrome-acp/shared/components/ai-elements/tool";
import { Shimmer } from "@chrome-acp/shared/components/ai-elements/shimmer";

interface ToolCallData {
  id: string;
  title: string;
  status: "running" | "complete" | "error";
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: Record<string, unknown>;
}

// Message part: either text or a tool call
type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCallData };

interface ChatMessageData {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
}

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

export function ChatInterface({ client }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  // Use ref for tracking current agent message ID to avoid stale closure issues
  const currentAgentMessageIdRef = useRef<string | null>(null);

  // Auto-create session on mount
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
      setIsLoading(false);
      currentAgentMessageIdRef.current = null;
    });

    // Create session
    client.createSession();
  }, [client]);

  const handleSessionUpdate = useCallback((update: SessionUpdate) => {
    if (update.sessionUpdate === "agent_message_chunk") {
      const text =
        update.content.type === "text" && update.content.text
          ? update.content.text
          : "";

      if (!text) return;

      setMessages((prev) => {
        if (currentAgentMessageIdRef.current) {
          // Find current message and append text
          return prev.map((msg) => {
            if (msg.id !== currentAgentMessageIdRef.current) return msg;

            const lastPart = msg.parts[msg.parts.length - 1];
            // If last part is text, append to it
            if (lastPart?.type === "text") {
              return {
                ...msg,
                parts: [
                  ...msg.parts.slice(0, -1),
                  { type: "text", text: lastPart.text + text },
                ],
              };
            }
            // Otherwise add new text part
            return {
              ...msg,
              parts: [...msg.parts, { type: "text", text }],
            };
          });
        } else {
          // Create new agent message
          const newId = `agent-${Date.now()}`;
          currentAgentMessageIdRef.current = newId;
          return [...prev, { id: newId, role: "assistant", parts: [{ type: "text", text }] }];
        }
      });
    } else if (update.sessionUpdate === "tool_call") {
      const mapStatus = (status: string): "running" | "complete" | "error" => {
        if (status === "completed") return "complete";
        if (status === "failed") return "error";
        return "running";
      };

      const toolCall: ToolCallData = {
        id: update.toolCallId,
        title: update.title,
        status: mapStatus(update.status),
        content: update.content,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      };

      setMessages((prev) => {
        if (!currentAgentMessageIdRef.current) {
          const newId = `agent-${Date.now()}`;
          currentAgentMessageIdRef.current = newId;
          return [
            ...prev,
            {
              id: newId,
              role: "assistant",
              parts: [{ type: "tool_call", toolCall }],
            },
          ];
        }
        // Add tool call as new part
        return prev.map((msg) =>
          msg.id === currentAgentMessageIdRef.current
            ? { ...msg, parts: [...msg.parts, { type: "tool_call", toolCall }] }
            : msg,
        );
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      const mapStatus = (
        status: string | undefined,
      ): "running" | "complete" | "error" | undefined => {
        if (!status) return undefined;
        if (status === "completed") return "complete";
        if (status === "failed") return "error";
        return "running";
      };

      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          parts: msg.parts.map((part) => {
            if (part.type !== "tool_call") return part;
            if (part.toolCall.id !== update.toolCallId) return part;

            const newStatus = mapStatus(update.status);
            const mergedContent = update.content
              ? [...(part.toolCall.content || []), ...update.content]
              : part.toolCall.content;

            return {
              type: "tool_call" as const,
              toolCall: {
                ...part.toolCall,
                ...(newStatus && { status: newStatus }),
                ...(update.title && { title: update.title }),
                content: mergedContent,
                ...(update.rawInput && { rawInput: update.rawInput }),
                ...(update.rawOutput && { rawOutput: update.rawOutput }),
              },
            };
          }),
        })),
      );
    }
  }, []);

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (!text || isLoading || !sessionReady) return;

    // Add user message
    const userMessage: ChatMessageData = {
      id: `user-${Date.now()}`,
      role: "user",
      parts: [{ type: "text", text }],
    };
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);

    try {
      await client.sendPrompt(text);
    } catch (error) {
      console.error("[ChatInterface] Failed to send prompt:", error);
      setIsLoading(false);
    }
  };

  const handleCancel = () => {
    client.cancel();
    setIsLoading(false);
  };

  const chatStatus = isLoading ? "streaming" : "ready";

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <Conversation className="flex-1">
        <ConversationContent>
          {!sessionReady ? (
            <div className="flex items-center justify-center p-4">
              <Shimmer>Creating session...</Shimmer>
            </div>
          ) : messages.length === 0 ? (
            <ConversationEmptyState
              title="Start a conversation"
              description="Type a message below to chat with the ACP agent"
            />
          ) : (
            <>
              {messages.map((message) => (
                <Message key={message.id} from={message.role}>
                  <MessageContent>
                    {message.parts.map((part, index) => {
                      if (part.type === "text") {
                        return (
                          <MessageResponse key={index}>{part.text}</MessageResponse>
                        );
                      }
                      // part.type === "tool_call"
                      const tool = part.toolCall;
                      const toolOutput = formatToolOutput(tool.content, tool.rawOutput);
                      const hasOutput =
                        tool.status !== "running" && toolOutput !== null;

                      return (
                        <Tool key={tool.id} defaultOpen={hasOutput}>
                          <ToolHeader
                            title={tool.title}
                            type="tool-invocation"
                            state={
                              tool.status === "error"
                                ? "output-error"
                                : tool.status === "running"
                                  ? "input-available"
                                  : "output-available"
                            }
                          />
                          <ToolContent>
                            {tool.rawInput && (
                              <ToolInput input={tool.rawInput} />
                            )}
                            <ToolOutput
                              output={toolOutput}
                              errorText={
                                tool.status === "error"
                                  ? "Tool execution failed"
                                  : undefined
                              }
                            />
                          </ToolContent>
                        </Tool>
                      );
                    })}
                  </MessageContent>
                </Message>
              ))}
              {/* Thinking indicator - show when loading and no agent response yet */}
              {isLoading && !currentAgentMessageIdRef.current && (
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
            placeholder={
              sessionReady ? "Type a message..." : "Waiting for session..."
            }
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
