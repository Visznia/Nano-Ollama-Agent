# Nano Ollama Agent

A small terminal-based coding agent that uses a local Ollama model and provides
file tools restricted to a configurable sandbox directory.

## Requirements

- Node.js 18 or newer
- [Ollama](https://ollama.com/download) installed and running
- A model downloaded in Ollama

## Setup

Open a terminal in this project directory and install the Node.js dependency:

```powershell
npm install
```

Download the model configured in `config.json` if it is not already installed:

```powershell
ollama pull qwen3.5:2b
```

Start the agent:

```powershell
npm start
```

Ollama must be running locally before you send a request. On Windows, starting
the Ollama application normally starts its local service.

## Configuration

Edit `config.json`:

```json
{
  "model": "qwen3.5:2b",
  "context_window": 32768,
  "sandbox_dir": "./sandbox"
}
```

- `model`: Ollama model name. The model must be available locally; use
  `ollama list` to see downloaded models.
- `context_window`: context size requested for each model call, in tokens.
- `sandbox_dir`: directory where the agent's file tools can read and write.
  Relative paths are resolved from this project directory. Absolute paths are
  also accepted.

Restart the agent after changing the configuration.

## Using the agent

Enter a request at the `You >` prompt. The model can use these tools:

- `list_files` to list files under the sandbox, including subdirectories.
- `read_file` to inspect a file using a path relative to the sandbox.
- `write_file` to create or replace a file using a path relative to the
  sandbox.

`write_file` replaces the entire file. When changing an existing file, the
agent should read it first and then write the complete updated contents.
Absolute paths and paths that escape the sandbox are rejected.

Terminal output includes the model's thinking and response, tool calls and
results, errors, token counts, configured context usage, and timing statistics.
Use `/help` to see the interactive commands (`/status`, `/clear`, and `/exit`
are also available).
