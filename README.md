# ACP adapter for Opencode


This tool implements an ACP agent for [Opencode](https://github.com/sst/opencode), allowing you to use Opencode from [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

It uses the official [Opencode SDK](https://opencode.ai/docs/sdk), supporting:
- Client MCP servers

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## How to use

### Zed

The latest version of Zed can already use this adapter out of the box.

To use Opencode, open the Agent Panel and click "New Opencode Thread" from the `+` button menu in the top-right:

https://github.com/user-attachments/assets/ddce66c7-79ac-47a3-ad59-4a6a3ca74903

Read the docs on [External Agent](https://zed.dev/docs/ai/external-agents) support.



#### Installation

Install the adapter from `npm`:

```bash
# Install dependencies
npm install
```

## Adding as an Agent Server

To add this agent as a server in your environment, include the following configuration:

```json
{
  "agent_servers": {
      "Opencode Agent": {
        "command": "npx",
        "args": [
          "tsx",
          "path/to/src/index.ts"
        ]
      }
    }
}
```

## License

Apache-2.0
