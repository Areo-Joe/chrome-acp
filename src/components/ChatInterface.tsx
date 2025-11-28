import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ChatMessage, type ChatMessageData, type ToolCall } from "@/components/ChatMessage";
import { Send, Square, Loader2 } from "lucide-react";
import type { ACPClient } from "@/acp/client";
import type { SessionUpdate } from "@/acp/types";

interface ChatInterfaceProps {
  client: ACPClient;
}

export function ChatInterface({ client }: ChatInterfaceProps) {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const currentAgentMessageId = useRef<string | null>(null);

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
      currentAgentMessageId.current = null;
    });

    // Create session
    client.createSession();
  }, [client]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSessionUpdate = useCallback((update: SessionUpdate) => {
    if (update.sessionUpdate === "agent_message_chunk") {
      const text = update.content.type === "text" && update.content.text
        ? update.content.text
        : "";

      if (!text) return;

      setMessages((prev) => {
        if (currentAgentMessageId.current) {
          // Append to existing message
          return prev.map((msg) =>
            msg.id === currentAgentMessageId.current
              ? { ...msg, content: msg.content + text }
              : msg
          );
        } else {
          // Create new agent message
          const newId = `agent-${Date.now()}`;
          currentAgentMessageId.current = newId;
          return [...prev, { id: newId, role: "agent", content: text, isStreaming: true }];
        }
      });
    } else if (update.sessionUpdate === "tool_call") {
      const toolCall: ToolCall = {
        id: update.toolCallId,
        title: update.title,
        status: update.status === "running" ? "running" : "complete",
      };

      setMessages((prev) => {
        if (!currentAgentMessageId.current) {
          const newId = `agent-${Date.now()}`;
          currentAgentMessageId.current = newId;
          return [...prev, { id: newId, role: "agent", content: "", toolCalls: [toolCall] }];
        }
        return prev.map((msg) =>
          msg.id === currentAgentMessageId.current
            ? { ...msg, toolCalls: [...(msg.toolCalls || []), toolCall] }
            : msg
        );
      });
    } else if (update.sessionUpdate === "tool_call_update") {
      setMessages((prev) =>
        prev.map((msg) => ({
          ...msg,
          toolCalls: msg.toolCalls?.map((tc) =>
            tc.id === update.toolCallId
              ? { ...tc, status: update.status === "complete" ? "complete" : "running" }
              : tc
          ),
        }))
      );
    }
  }, []);

  const handleSubmit = async () => {
    const text = inputValue.trim();
    if (!text || isLoading || !sessionReady) return;

    // Add user message
    const userMessage: ChatMessageData = {
      id: `user-${Date.now()}`,
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMessage]);
    setInputValue("");
    setIsLoading(true);

    try {
      await client.sendPrompt(text);
    } catch (error) {
      console.error("[ChatInterface] Failed to send prompt:", error);
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleCancel = () => {
    client.cancel();
    setIsLoading(false);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto space-y-2 pb-4">
        {!sessionReady && (
          <div className="flex items-center justify-center p-4 text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Creating session...
          </div>
        )}
        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div className="border-t pt-4 space-y-2">
        <Textarea
          ref={textareaRef}
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={sessionReady ? "Type a message..." : "Waiting for session..."}
          disabled={!sessionReady}
          className="min-h-[80px] resize-none"
        />
        <div className="flex justify-end gap-2">
          {isLoading ? (
            <Button onClick={handleCancel} variant="destructive" size="sm">
              <Square className="w-4 h-4 mr-1" /> Cancel
            </Button>
          ) : (
            <Button
              onClick={handleSubmit}
              disabled={!inputValue.trim() || !sessionReady}
              size="sm"
            >
              <Send className="w-4 h-4 mr-1" /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

