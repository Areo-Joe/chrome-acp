import { useState, useEffect, useCallback, useRef } from "react";
import { Loader2 } from "lucide-react";
import type { ACPClient } from "@/acp/client";
import type { SessionUpdate } from "@/acp/types";

// AI Elements components
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputSubmit,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolOutput,
} from "@/components/ai-elements/tool";

interface ToolCallData {
  id: string;
  title: string;
  status: "running" | "complete" | "error";
}

interface ChatMessageData {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCallData[];
}

interface ChatInterfaceProps {
  client: ACPClient;
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
        // Check if we already have a current agent message
        if (currentAgentMessageIdRef.current) {
          // Append to existing message
          return prev.map((msg) =>
            msg.id === currentAgentMessageIdRef.current
              ? { ...msg, content: msg.content + text }
              : msg,
          );
        } else {
          // Create new agent message
          const newId = `agent-${Date.now()}`;
          currentAgentMessageIdRef.current = newId;
          return [...prev, { id: newId, role: "assistant", content: text }];
        }
      });
    } else if (update.sessionUpdate === "tool_call") {
      const toolCall: ToolCallData = {
        id: update.toolCallId,
        title: update.title,
        status: update.status === "running" ? "running" : "complete",
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
              content: "",
              toolCalls: [toolCall],
            },
          ];
        }
        return prev.map((msg) =>
          msg.id === currentAgentMessageIdRef.current
            ? { ...msg, toolCalls: [...(msg.toolCalls || []), toolCall] }
            : msg,
        );
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          toolCalls: msg.toolCalls?.map((tc) =>
            tc.id === update.toolCallId
              ? {
                  ...tc,
                  status: update.status === "complete" ? "complete" : "running",
                }
              : tc,
          ),
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
      content: text,
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
            <div className="flex items-center justify-center p-4 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Creating session...
            </div>
          ) : messages.length === 0 ? (
            <ConversationEmptyState
              title="Start a conversation"
              description="Type a message below to chat with the ACP agent"
            />
          ) : (
            messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  {message.content && (
                    <MessageResponse>{message.content}</MessageResponse>
                  )}
                  {message.toolCalls?.map((tool) => (
                    <Tool key={tool.id}>
                      <ToolHeader
                        title={tool.title}
                        type="tool-invocation"
                        state={
                          tool.status === "running"
                            ? "input-available"
                            : "output-available"
                        }
                      />
                      <ToolContent>
                        <ToolOutput
                          output={null}
                          errorText={
                            tool.status === "error"
                              ? "Tool execution failed"
                              : undefined
                          }
                        />
                      </ToolContent>
                    </Tool>
                  ))}
                </MessageContent>
              </Message>
            ))
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
