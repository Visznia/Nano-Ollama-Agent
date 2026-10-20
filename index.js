import { Ollama } from 'ollama';
import fs from 'fs/promises';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { Agent, fetch as undiciFetch } from 'undici';

const PROJECT_DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(PROJECT_DIR, 'config.json');
const MAX_ACTION_RETRIES = 2;
const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));

if (typeof config.model !== 'string' || !config.model.trim()) {
  throw new Error(`Invalid "model" in ${CONFIG_PATH}: expected a non-empty string.`);
}
if (!Number.isInteger(config.context_window) || config.context_window <= 0) {
  throw new Error(`Invalid "context_window" in ${CONFIG_PATH}: expected a positive integer.`);
}
if (
  config.stream_idle_timeout_ms !== undefined
  && (!Number.isInteger(config.stream_idle_timeout_ms) || config.stream_idle_timeout_ms <= 0)
) {
  throw new Error(`Invalid "stream_idle_timeout_ms" in ${CONFIG_PATH}: expected a positive integer.`);
}
if (typeof config.sandbox_dir !== 'string' || !config.sandbox_dir.trim()) {
  throw new Error(`Invalid "sandbox_dir" in ${CONFIG_PATH}: expected a non-empty path.`);
}

const MODEL = config.model;
const CONTEXT_WINDOW = config.context_window;
const STREAM_IDLE_TIMEOUT_MS = config.stream_idle_timeout_ms ?? 1800000;
const SANDBOX_DIR = path.resolve(PROJECT_DIR, config.sandbox_dir);
const ollamaDispatcher = new Agent({
  bodyTimeout: STREAM_IDLE_TIMEOUT_MS,
  headersTimeout: STREAM_IDLE_TIMEOUT_MS,
});
const ollama = new Ollama({
  fetch: (input, options = {}) => undiciFetch(input, {
    ...options,
    dispatcher: ollamaDispatcher,
  }),
});
await fs.mkdir(SANDBOX_DIR, { recursive: true });

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const useColors = process.stdout.isTTY && !process.env.NO_COLOR;
const colors = {
  reset: useColors ? '\x1b[0m' : '',
  dim: useColors ? '\x1b[90m' : '',
  red: useColors ? '\x1b[31m' : '',
  green: useColors ? '\x1b[32m' : '',
  yellow: useColors ? '\x1b[33m' : '',
  cyan: useColors ? '\x1b[36m' : '',
  bold: useColors ? '\x1b[1m' : '',
};

const messages = [
  {
    role: 'system',
    content: `You are a coding agent. Work directly on files using the tools provided. The sandbox is ${SANDBOX_DIR}.

Use the file tools like this:
- To see what files exist, call list_files. It needs no arguments.
- To inspect a file, call read_file with its relative path, such as "index.html" or "src/app.js".
- To create or change a file, call write_file with its relative path and the complete new file content. write_file replaces the whole file, so read it first if you need to preserve existing content.
- File paths are relative to the sandbox. You may use subfolders; do not use absolute paths.

When asked to change files, do the work with the tools instead of replying with a plan. Wait for tool results and correct errors. Do not claim a change succeeded unless write_file reports success. After the work, give a brief summary.

For questions that do not ask for file changes, answer directly and concisely.`,
  },
];

const tools = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a file or replace its entire contents. Use a path relative to the sandbox, for example "index.html" or "src/app.js". If you need to keep existing content, call read_file first, then send the complete updated file.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Relative file path, for example "index.html" or "src/app.js"' },
          content: { type: 'string', description: 'The complete contents the file should have after writing' },
        },
        required: ['filename', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read one file from the sandbox. Use its relative path, such as "index.html" or "src/app.js". Call this before write_file when you need to preserve existing content.',
      parameters: {
        type: 'object',
        properties: {
          filename: { type: 'string', description: 'Relative file path, such as "index.html" or "src/app.js"' },
        },
        required: ['filename'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files in the sandbox, including files in subfolders. Call this first when you do not know a file path. Takes no arguments.',
      parameters: { type: 'object', properties: {} },
    },
  },
];

function formatError(error) {
  if (error instanceof Error) {
    const details = [error.stack || `${error.name}: ${error.message}`];
    if ('status_code' in error) details.push(`HTTP status: ${error.status_code}`);
    if ('cause' in error && error.cause) details.push(`Cause: ${String(error.cause)}`);
    return details.join('\n');
  }
  return String(error);
}

function formatDuration(nanoseconds) {
  if (!Number.isFinite(nanoseconds)) return 'n/a';
  const seconds = nanoseconds / 1e9;
  return seconds < 1 ? `${(seconds * 1000).toFixed(0)} ms` : `${seconds.toFixed(2)} s`;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString() : 'n/a';
}

function isFileChangeRequest(input) {
  if (/^\s*(how|what|why|when|where|explain|describe|tell me|show me)\b/i.test(input)) {
    return false;
  }

  return /^\s*(please\s+)?(create|write|edit|modify|change|update|improve|fix|refactor|add|remove|delete|rename|implement|build|generate|replace|append|insert|enhance)\b/i.test(input)
    || /\b(i want you to|i'd like you to|can you|could you|would you|please)\b[\s\S]{0,120}\b(create|write|edit|modify|change|update|improve|fix|refactor|add|remove|delete|rename|implement|build|generate|replace|append|insert|enhance)\b/i.test(input)
    || /\bmake\s+(this|the|it|him|her)\b[\s\S]{0,80}\b(better|clearer|faster|simpler|more|less|work|use|look)\b/i.test(input);
}

function getSandboxFilePath(filename) {
  if (typeof filename !== 'string' || !filename.trim()) {
    throw new Error('A non-empty filename is required.');
  }

  if (path.isAbsolute(filename)) {
    throw new Error('Use a path relative to the sandbox, not an absolute path.');
  }

  const filePath = path.resolve(SANDBOX_DIR, filename);
  const relativePath = path.relative(SANDBOX_DIR, filePath);
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    throw new Error('The file path must point to a file inside the sandbox.');
  }

  return filePath;
}

async function executeTool(name, args = {}) {
  try {
    switch (name) {
      case 'write_file': {
        const filePath = getSandboxFilePath(args.filename);
        if (typeof args.content !== 'string') {
          throw new Error('The file content must be a string.');
        }
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, args.content, 'utf-8');
        return `Success: '${path.relative(SANDBOX_DIR, filePath)}' written (${Buffer.byteLength(args.content, 'utf-8')} bytes).`;
      }
      case 'read_file': {
        const filePath = getSandboxFilePath(args.filename);
        return await fs.readFile(filePath, 'utf-8');
      }
      case 'list_files': {
        const files = [];
        async function walk(directory) {
          const entries = await fs.readdir(directory, { withFileTypes: true });
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            const entryPath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
              await walk(entryPath);
            } else if (entry.isFile()) {
              files.push(path.relative(SANDBOX_DIR, entryPath));
            }
          }
        }
        await walk(SANDBOX_DIR);
        return files.length ? files.join('\n') : '(sandbox is empty)';
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const detail = formatError(error);
    console.error(`\n${colors.red}[Tool error: ${name}]${colors.reset}\n${detail}\n`);
    return `Error executing ${name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function printUsage(stats) {
  const promptTokens = stats.prompt_eval_count;
  const usedPercent = Number.isFinite(promptTokens)
    ? (promptTokens / CONTEXT_WINDOW) * 100
    : undefined;
  const usedLabel = Number.isFinite(promptTokens)
    ? `${formatNumber(promptTokens)} / ${formatNumber(CONTEXT_WINDOW)} tokens${usedPercent === undefined ? '' : ` (${usedPercent.toFixed(1)}%)`}`
    : `not reported / ${formatNumber(CONTEXT_WINDOW)} tokens`;
  const remaining = Number.isFinite(promptTokens)
    ? `${formatNumber(Math.max(0, CONTEXT_WINDOW - promptTokens))} tokens`
    : 'n/a';
  const generationRate = stats.eval_duration > 0
    ? `${(stats.eval_count / (stats.eval_duration / 1e9)).toFixed(1)} tokens/s`
    : 'n/a';

  console.log(`${colors.dim}  ┌─ Run statistics${colors.reset}`);
  console.log(`${colors.dim}  │${colors.reset} Model: ${stats.model || MODEL}`);
  console.log(`${colors.dim}  │${colors.reset} Context used: ${usedLabel}`);
  console.log(`${colors.dim}  │${colors.reset} Context remaining (configured): ${remaining}`);
  console.log(`${colors.dim}  │${colors.reset} Tokens: ${formatNumber(stats.prompt_eval_count)} prompt + ${formatNumber(stats.eval_count)} generated`);
  console.log(`${colors.dim}  │${colors.reset} Speed: ${generationRate}`);
  console.log(`${colors.dim}  │${colors.reset} Time: total ${formatDuration(stats.total_duration)}, model load ${formatDuration(stats.load_duration)}, prompt ${formatDuration(stats.prompt_eval_duration)}, generation ${formatDuration(stats.eval_duration)}`);
  if (stats.done_reason) {
    console.log(`${colors.dim}  │${colors.reset} Stop reason: ${stats.done_reason}`);
  }
  console.log(`${colors.dim}  └─────────────────${colors.reset}`);
}

async function streamChat(msgs) {
  let fullContent = '';
  let fullThinking = '';
  const toolCalls = [];
  let hasThinkingHeader = false;
  let hasResponseHeader = false;
  let stats = {};
  let phase = 'waiting for Ollama';
  let chunkCount = 0;
  let thinkingCharacters = 0;
  let responseCharacters = 0;
  let lastChunkAt = Date.now();
  let lastProgressAt = lastChunkAt;
  let needsContinuationHeader = false;
  const requestStartedAt = lastChunkAt;

  console.log(`\n${colors.cyan}${colors.bold}  Agent${colors.reset}`);

  const progressTimer = setInterval(() => {
    const now = Date.now();
    if (now - lastChunkAt < 10000 || now - lastProgressAt < 10000) return;

    const details = [
      `still working: ${phase}`,
      `${formatDuration((now - requestStartedAt) * 1e6)} elapsed`,
      `${formatDuration((now - lastChunkAt) * 1e6)} since last update`,
      `${chunkCount} chunks`,
      `${formatNumber(thinkingCharacters)} thinking chars`,
      `${formatNumber(responseCharacters)} response chars`,
      `${toolCalls.length} tool calls`,
    ];

    process.stdout.write(`\n${colors.dim}  [${details.join(' | ')}]${colors.reset}\n`);
    lastProgressAt = now;
    needsContinuationHeader = hasThinkingHeader || hasResponseHeader;
  }, 1000);

  try {
    const stream = await ollama.chat({
      model: MODEL,
      messages: msgs,
      tools,
      stream: true,
      options: {
        num_ctx: CONTEXT_WINDOW,
        temperature: 0.1,
      }
    });

    for await (const chunk of stream) {
      chunkCount += 1;
      lastChunkAt = Date.now();

      const thinking = chunk.message?.thinking;
      if (thinking) {
        phase = 'model is thinking';
        if (needsContinuationHeader) {
          process.stdout.write(`  ${colors.dim}Thinking (continued):${colors.reset} `);
          needsContinuationHeader = false;
          hasThinkingHeader = true;
        } else if (!hasThinkingHeader) {
          process.stdout.write(`  ${colors.dim}Thinking:${colors.reset} `);
          hasThinkingHeader = true;
        }
        process.stdout.write(thinking);
        fullThinking += thinking;
        thinkingCharacters += thinking.length;
      }

      const content = chunk.message?.content;
      if (content) {
        phase = 'model is writing its response';
        if (needsContinuationHeader) {
          process.stdout.write(`  ${colors.green}Response (continued):${colors.reset} `);
          needsContinuationHeader = false;
          hasResponseHeader = true;
        } else if (!hasResponseHeader) {
          if (hasThinkingHeader) process.stdout.write('\n');
          process.stdout.write(`  ${colors.green}Response:${colors.reset} `);
          hasResponseHeader = true;
        }
        process.stdout.write(content);
        fullContent += content;
        responseCharacters += content.length;
      }

      if (chunk.message?.tool_calls) {
        phase = 'model is preparing tool calls';
        toolCalls.push(...chunk.message.tool_calls);
      }

      if (chunk.done) {
        stats = {
          model: chunk.model,
          total_duration: chunk.total_duration,
          load_duration: chunk.load_duration,
          prompt_eval_count: chunk.prompt_eval_count,
          prompt_eval_duration: chunk.prompt_eval_duration,
          eval_count: chunk.eval_count,
          eval_duration: chunk.eval_duration,
          done_reason: chunk.done_reason,
        };
      }
    }
  } finally {
    clearInterval(progressTimer);
  }

  if (hasThinkingHeader || hasResponseHeader) process.stdout.write('\n');
  if (Object.keys(stats).length) printUsage(stats);
  else console.log(`${colors.yellow}  Run statistics were not included in the Ollama stream.${colors.reset}`);
  console.log();

  return {
    message: {
      role: 'assistant',
      content: fullContent,
      ...(fullThinking ? { thinking: fullThinking } : {}),
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    },
    stats,
  };
}

function showHelp() {
  console.log(`\n${colors.bold}Commands${colors.reset}
  /help    Show these commands
  /status  Show model, context limit, and conversation size
  /clear   Start a fresh conversation
  /exit    Quit the agent\n`);
}

function showStatus(lastPromptTokens) {
  console.log(`\n${colors.cyan}${colors.bold}  Agent status${colors.reset}`);
  console.log(`  Model: ${MODEL}`);
  console.log(`  Configured context window: ${formatNumber(CONTEXT_WINDOW)} tokens`);
  console.log(`  Stream idle timeout: ${formatDuration(STREAM_IDLE_TIMEOUT_MS * 1e6)}`);
  console.log(`  Last reported prompt usage: ${Number.isFinite(lastPromptTokens) ? `${formatNumber(lastPromptTokens)} tokens (${((lastPromptTokens / CONTEXT_WINDOW) * 100).toFixed(1)}%)` : 'not available yet'}`);
  console.log(`  Conversation messages: ${messages.length}`);
  console.log(`  Sandbox: ${SANDBOX_DIR}\n`);
}

async function runAgentLoop() {
  let lastPromptTokens;
  const input = rl[Symbol.asyncIterator]();

  console.log(`${colors.cyan}${colors.bold}Nano Ollama Agent${colors.reset}`);
  console.log(`  Model: ${MODEL}  |  Context: ${formatNumber(CONTEXT_WINDOW)} tokens`);
  console.log(`  Config: ${CONFIG_PATH}`);
  console.log(`  Sandbox: ${SANDBOX_DIR}`);
  console.log(`  Type /help for commands.\n`);
  rl.setPrompt(`${colors.cyan}You > ${colors.reset}`);

  while (true) {
    rl.prompt();
    const { value: rawInput, done } = await input.next();
    if (done) break;

    const userInput = rawInput.trim();
    if (!userInput) continue;

    const command = userInput.toLowerCase();
    if (command === '/exit' || command === 'exit') break;
    if (command === '/help') {
      showHelp();
      continue;
    }
    if (command === '/status') {
      showStatus(lastPromptTokens);
      continue;
    }
    if (command === '/clear') {
      messages.splice(1);
      console.log(`${colors.green}Conversation history cleared.${colors.reset}\n`);
      lastPromptTokens = undefined;
      continue;
    }

    messages.push({ role: 'user', content: userInput });
    let toolRound = 0;
    let actionRetries = 0;
    let changeCompleted = false;
    const requiresFileChange = isFileChangeRequest(userInput);
    const turnStartedAt = Date.now();

    try {
      while (true) {
        const { message: responseMessage, stats } = await streamChat(messages);
        if (Number.isFinite(stats.prompt_eval_count)) {
          lastPromptTokens = stats.prompt_eval_count;
        }
        messages.push(responseMessage);

        if (!responseMessage.tool_calls?.length) {
          if (requiresFileChange && !changeCompleted && actionRetries < MAX_ACTION_RETRIES) {
            actionRetries += 1;
            console.log(`${colors.yellow}  No successful file edit yet. Requesting tool execution (retry ${actionRetries}/${MAX_ACTION_RETRIES}).${colors.reset}`);
            messages.push({
              role: 'user',
              content: 'Your last response described the requested change, but no file was written. Continue the original request now: call list_files or read_file if needed, then call write_file with the relative file path and complete updated content. Do not give another plan or claim completion without a successful write_file result.',
            });
            continue;
          }
          break;
        }

        toolRound += 1;
        console.log(`${colors.yellow}  Tool round ${toolRound} (${responseMessage.tool_calls.length} call${responseMessage.tool_calls.length === 1 ? '' : 's'})${colors.reset}`);
        for (const call of responseMessage.tool_calls) {
          const toolName = call.function.name;
          const toolArgs = call.function.arguments || {};
          console.log(`\n${colors.yellow}  ┌─ Tool: ${toolName}${colors.reset}`);
          console.log(`  │ Arguments: ${JSON.stringify(toolArgs, null, 2).replace(/\n/g, '\n  │ ')}`);
          const toolResult = await executeTool(toolName, toolArgs);
          const isError = toolResult.startsWith('Error executing ');
          if (
            !isError
            && toolName === 'write_file'
          ) {
            changeCompleted = true;
          }
          console.log(`  │ ${isError ? 'Result: ERROR' : 'Result:'}${colors.reset}`);
          console.log(toolResult.split('\n').map((line) => `  │ ${line}`).join('\n'));
          console.log(`${colors.yellow}  └────────────────────${colors.reset}`);

          messages.push({
            role: 'tool',
            tool_name: toolName,
            content: toolResult,
          });
        }
      }
      if (requiresFileChange && !changeCompleted) {
        console.error(`${colors.red}${colors.bold}Requested change was not completed.${colors.reset} No successful file edit was confirmed after ${MAX_ACTION_RETRIES} retries. Check the model response and tool errors above.\n`);
      }
    } catch (error) {
      console.error(`\n${colors.red}${colors.bold}Agent request failed${colors.reset}`);
      console.error(formatError(error));
      console.error(`${colors.dim}Check that Ollama is running and the model "${MODEL}" is available. If this was a BodyTimeoutError during generation, increase "stream_idle_timeout_ms" in config.json.${colors.reset}\n`);
    }

    console.log(`${colors.dim}Turn completed in ${((Date.now() - turnStartedAt) / 1000).toFixed(1)} s. Conversation: ${messages.length} messages.${colors.reset}\n`);
  }

  rl.close();
  console.log('\nAgent stopped.');
}

rl.on('SIGINT', () => {
  console.log('\nInterrupted. Closing agent...');
  rl.close();
});

runAgentLoop().catch((error) => {
  console.error(`${colors.red}${colors.bold}Fatal agent error${colors.reset}`);
  console.error(formatError(error));
  rl.close();
  process.exitCode = 1;
});
