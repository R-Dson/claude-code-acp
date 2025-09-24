# OpenCode ACP Adapter

A robust ACP (Agent Client Protocol) adapter that bridges [OpenCode](https://github.com/sst/opencode) with ACP-compatible clients like [Zed](https://zed.dev). This adapter uses the official [OpenCode SDK](https://opencode.ai/docs/sdk) to provide AI-powered coding assistance.

## What This Does

This adapter enables seamless integration between OpenCode and ACP-compatible editors. It translates between the two protocols, allowing you to use OpenCode's powerful AI capabilities directly within your editor.

The adapter provides real-time streaming responses, file operations, terminal integration, and a flexible permission system. It supports multiple operation modes ranging from fully interactive to analysis-only.

## Key Features

**Session Management**: Create, load, and manage coding sessions with full conversation history and context preservation.

**File Operations**: Read, write, and edit files.

**Terminal Integration**: Execute bash commands with real-time output streaming. Run long-running processes in the background and manage them through the interface.

**Permission System**: Choose from different security levels - from always asking for permission to fully automated operation, plus a special planning mode for analysis without modifications.

**Custom Commands**: Use built-in commands like `/compact`, `/init`, `/models`, and `/help`, or define your own commands through configuration files.

## Installation

### From source

```bash
git clone https://github.com/zed-industries/opencode-acp.git
cd opencode-acp
npm install
npm run build
```

## Configuration

### Zed Integration

The latest version of Zed supports this adapter out of the box. Simply open the Agent Panel and click "New Opencode Thread" from the `+` button menu.

For manual configuration, add this to your Zed settings:

```json
{
  "agent_servers": {
    "Opencode Agent": {
      "command": "npx",
      "args": ["tsx", "path/to/src/index.ts"]
    }
  }
}
```

## Usage

Start the adapter with `npm start`, then connect from your ACP-compatible client. You'll have access to AI-powered coding assistance with real-time responses.

### Available Commands

- `/help` - Show available commands
- `/models` - List available AI models
- `/init` - Analyze project and create AGENTS.md
- `/compact` - Summarize current session
- `/undo` - Undo last message
- `/redo` - Redo last undone message
- `/share` - Share current session
- `/unshare` - Unshare current session

### Permission Modes

The adapter offers several permission modes to suit different workflows:

- **Default Mode**: Prompts for each tool usage
- **Accept Edits**: Auto-approves file modifications
- **Bypass Permissions**: No prompts (use with caution)
- **Plan Mode**: Analysis only, no file changes

## Development

### Architecture

The adapter consists of several key components:

- **ACP Agent** (`acp-agent.ts`): Main protocol implementation with session management
- **MCP Server** (`mcp-server.ts`): Provides file and terminal operations
- **Tool Handler** (`tools.ts`): Converts between different tool call formats
- **Command Loader** (`command-loader.ts`): Manages custom commands
- **Utilities** (`utils.ts`): Helper functions for streaming and file operations

The system uses an event-driven architecture to handle real-time streaming responses and provides a clean bridge between the ACP and OpenCode protocols.

## Supported Tools

The adapter provides agent tool support for common development tasks:

**File Operations**: Read, write, edit, and multi-edit files with intelligent diff generation and line tracking.

**Terminal Operations**: Execute bash commands, manage background processes, and handle output streaming.

**Search Operations**: Use grep for text search, glob patterns for file finding, and directory listing.

**Web Operations**: Fetch web content and perform web searches.

**Planning Tools**: Manage task lists and handle complex multi-step operations.

## License

Apache-2.0 - See [LICENSE](LICENSE) for details.

## Links

- [OpenCode](https://github.com/sst/opencode) - The AI coding assistant
- [Agent Client Protocol](https://agentclientprotocol.com/) - The protocol specification
- [Zed Editor](https://zed.dev/) - Compatible client
- [OpenCode SDK](https://opencode.ai/docs/sdk) - Official SDK documentation
