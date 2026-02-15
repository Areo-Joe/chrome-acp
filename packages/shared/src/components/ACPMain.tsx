import { FolderOpen, MessageSquare } from "lucide-react";
import type { ACPClient } from "../acp/client";
import { ChatInterface } from "./ChatInterface";
import { FileExplorer } from "./FileExplorer";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

interface ACPMainProps {
  client: ACPClient;
}

/**
 * Main container component that provides tabs for Chat and File explorer.
 * This component should be rendered after successful connection.
 */
export function ACPMain({ client }: ACPMainProps) {
  return (
    <Tabs defaultValue="chat" className="flex flex-col h-full w-full">
      <TabsList className="mx-2 mt-2 self-center">
        <TabsTrigger value="chat" className="gap-1.5">
          <MessageSquare className="h-4 w-4" />
          <span>Chat</span>
        </TabsTrigger>
        <TabsTrigger value="files" className="gap-1.5">
          <FolderOpen className="h-4 w-4" />
          <span>Files</span>
        </TabsTrigger>
      </TabsList>

      <TabsContent value="chat" className="flex-1 overflow-hidden m-0">
        <ChatInterface client={client} />
      </TabsContent>

      <TabsContent value="files" className="flex-1 overflow-hidden m-0">
        <FileExplorer client={client} />
      </TabsContent>
    </Tabs>
  );
}
