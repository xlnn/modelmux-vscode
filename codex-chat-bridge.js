'use strict';

const http = require('http');
const { URL } = require('url');

// The bridge deliberately keeps its protocol surface small. Codex sends a
// Responses request, while most third-party gateways expose Chat Completions.
// Unsupported Responses-only features are rejected explicitly instead of
// being silently dropped and producing a subtly broken agent session.
const DEFAULT_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_SSE_LINE_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_HOST = '127.0.0.1';

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'content-length', 'host', 'keep-alive', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'
]);

function bridgeError(message, statusCode = 400, code = 'invalid_request_error') {
  const error = new Error(String(message));
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) throw bridgeError(`${label} must be a JSON object.`);
  return value;
}

function finiteInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw bridgeError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedString(value, label, maximum = 1024 * 1024, required = false) {
  if (value === undefined || value === null) {
    if (required) throw bridgeError(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim())) {
    throw bridgeError(`${label} must be a string of at most ${maximum} characters.`);
  }
  return value;
}

function cloneJson(value, label = 'value', depth = 0) {
  if (depth > 32) throw bridgeError(`${label} exceeds the maximum nesting depth.`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw bridgeError(`${label} contains a non-finite number.`);
    return value;
  }
  if (Array.isArray(value)) return value.map((item, index) => cloneJson(item, `${label}[${index}]`, depth + 1));
  if (!isPlainObject(value)) throw bridgeError(`${label} contains an unsupported value.`);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw bridgeError(`${label} contains a reserved property.`);
    }
    result[key] = cloneJson(item, `${label}.${key}`, depth + 1);
  }
  return result;
}

function payloadSize(value, label = 'payload', maximum = DEFAULT_MAX_PAYLOAD_BYTES) {
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch (error) { throw bridgeError(`${label} is not serializable: ${error.message || error}`); }
  if (Buffer.byteLength(serialized, 'utf8') > maximum) {
    throw bridgeError(`${label} exceeds the ${maximum}-byte limit.`);
  }
  return serialized;
}

function textContent(value, label = 'content') {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value.map(item => textContent(item, label)).filter(Boolean).join('');
  }
  if (isPlainObject(value)) {
    if (typeof value.text === 'string') return value.text;
    if (typeof value.output_text === 'string') return value.output_text;
    if (typeof value.content === 'string') return value.content;
  }
  throw bridgeError(`${label} must contain text.`);
}

function inputPartToChat(part, label = 'input part') {
  if (typeof part === 'string') return { type: 'text', text: part };
  assertPlainObject(part, label);
  const type = String(part.type || '').trim();
  if (type === 'input_text' || type === 'text' || type === 'output_text') {
    return { type: 'text', text: boundedString(part.text, `${label}.text`) };
  }
  if (type === 'input_image' || type === 'image_url') {
    const imageUrl = typeof part.image_url === 'string'
      ? part.image_url
      : isPlainObject(part.image_url) ? part.image_url.url : undefined;
    if (!imageUrl || imageUrl.length > 8 * 1024 * 1024) throw bridgeError(`${label}.image_url is invalid.`);
    const detail = ['low', 'high', 'auto', 'original'].includes(part.detail) ? part.detail : undefined;
    return { type: 'image_url', image_url: detail ? { url: imageUrl, detail } : { url: imageUrl } };
  }
  if (type === 'input_file' || type === 'file') {
    throw bridgeError(`${label} uses input_file, which Chat Completions gateways do not uniformly support.`, 400, 'unsupported_input_type');
  }
  throw bridgeError(`${label} uses unsupported type “${type || 'unknown'}”.`, 400, 'unsupported_input_type');
}

function messageContentToChat(content, label = 'message.content') {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return textContent(content, label);
  const parts = content.map((part, index) => inputPartToChat(part, `${label}[${index}]`));
  if (!parts.length) return '';
  if (parts.every(part => part.type === 'text')) return parts.map(part => part.text).join('');
  return parts;
}

function roleForResponsesMessage(role, label) {
  const normalized = String(role || '').toLowerCase();
  if (['system', 'developer', 'user', 'assistant', 'tool'].includes(normalized)) return normalized;
  throw bridgeError(`${label}.role is unsupported.`);
}

function functionCallToAssistantTool(call, label = 'function_call') {
  assertPlainObject(call, label);
  const callId = boundedString(call.call_id || call.id, `${label}.call_id`, 512, true);
  const name = boundedString(call.name, `${label}.name`, 512, true);
  const args = typeof call.arguments === 'string' ? call.arguments : JSON.stringify(cloneJson(call.arguments || {}, `${label}.arguments`));
  return {
    type: 'function',
    id: callId,
    function: { name, arguments: args }
  };
}

function responsesItemToChat(item, index) {
  const label = `input[${index}]`;
  if (typeof item === 'string') return { role: 'user', content: item };
  assertPlainObject(item, label);
  const type = String(item.type || '').trim();
  if (!type || type === 'message') {
    const role = roleForResponsesMessage(item.role || 'user', label);
    if (role === 'tool') {
      const toolCallId = boundedString(item.tool_call_id || item.call_id, `${label}.tool_call_id`, 512, true);
      return { role: 'tool', tool_call_id: toolCallId, content: textContent(item.output ?? item.content, `${label}.output`) };
    }
    return { role, content: messageContentToChat(item.content, `${label}.content`) };
  }
  if (type === 'input_text' || type === 'input_image' || type === 'input_file') {
    return { role: 'user', content: [inputPartToChat(item, label)] };
  }
  if (type === 'function_call') {
    return { role: 'assistant', content: null, tool_calls: [functionCallToAssistantTool(item, label)] };
  }
  if (type === 'function_call_output') {
    const toolCallId = boundedString(item.call_id || item.tool_call_id, `${label}.call_id`, 512, true);
    return { role: 'tool', tool_call_id: toolCallId, content: textContent(item.output, `${label}.output`) };
  }
  if (type === 'reasoning' || type === 'item_reference') {
    // Reasoning and references are Responses bookkeeping; Chat gateways do
    // not have an equivalent input message. They are safe to omit.
    return undefined;
  }
  throw bridgeError(`${label} uses unsupported item type “${type}”.`, 400, 'unsupported_input_type');
}

function responsesToolToChat(tool, index) {
  const label = `tools[${index}]`;
  assertPlainObject(tool, label);
  if (tool.type !== 'function') {
    throw bridgeError(`${label} uses unsupported tool type “${tool.type || 'unknown'}”.`, 400, 'unsupported_tool');
  }
  const name = boundedString(tool.name, `${label}.name`, 512, true);
  const description = tool.description === undefined ? undefined : boundedString(tool.description, `${label}.description`, 1024 * 1024);
  const parameters = tool.parameters === undefined
    ? tool.parameters_json_schema
    : tool.parameters;
  const fn = { name };
  if (description) fn.description = description;
  if (parameters !== undefined) fn.parameters = cloneJson(parameters, `${label}.parameters`);
  if (tool.strict !== undefined) fn.strict = Boolean(tool.strict);
  return { type: 'function', function: fn };
}

function responseFormatToChat(text) {
  if (!isPlainObject(text) || !isPlainObject(text.format)) return undefined;
  const format = text.format;
  if (format.type === 'json_object') return { type: 'json_object' };
  if (format.type === 'json_schema') {
    const name = boundedString(format.name, 'text.format.name', 512, true);
    const schema = cloneJson(format.schema || format.json_schema, 'text.format.schema');
    const result = { type: 'json_schema', json_schema: { name, schema } };
    if (format.description) result.json_schema.description = boundedString(format.description, 'text.format.description', 1024 * 1024);
    if (format.strict !== undefined) result.json_schema.strict = Boolean(format.strict);
    return result;
  }
  throw bridgeError(`Unsupported Responses text format “${format.type || 'unknown'}”.`, 400, 'unsupported_format');
}

function toolChoiceToChat(value) {
  if (value === undefined || value === null) return undefined;
  if (['auto', 'none', 'required'].includes(value)) return value;
  if (!isPlainObject(value)) throw bridgeError('tool_choice must be auto, none, required, or a function selector.');
  if (value.type !== 'function') throw bridgeError('Only function tool_choice is supported by the bridge.', 400, 'unsupported_tool_choice');
  return { type: 'function', function: { name: boundedString(value.name, 'tool_choice.name', 512, true) } };
}

function copyScalar(source, target, key, outputKey = key) {
  const value = source[key];
  if (value === undefined || value === null) return;
  if (typeof value === 'number' && !Number.isFinite(value)) throw bridgeError(`${key} must be finite.`);
  if (!['string', 'number', 'boolean'].includes(typeof value)) return;
  target[outputKey] = value;
}

/**
 * Convert an OpenAI Responses request to an OpenAI Chat Completions request.
 * The result is intentionally a new object containing only Chat fields.
 */
function responsesRequestToChat(request, options = {}) {
  assertPlainObject(request, 'Responses request');
  const source = cloneJson(request, 'Responses request');
  const messages = [];
  if (source.instructions !== undefined) {
    if (typeof source.instructions === 'string') {
      if (source.instructions.length) messages.push({ role: 'system', content: source.instructions });
    } else if (Array.isArray(source.instructions)) {
      for (const [index, item] of source.instructions.entries()) {
        const converted = responsesItemToChat(item, `instructions[${index}]`);
        if (converted) messages.push({ ...converted, role: converted.role === 'user' ? 'system' : converted.role });
      }
    } else {
      throw bridgeError('instructions must be a string or array.');
    }
  }

  const input = source.input === undefined ? [] : source.input;
  if (typeof input === 'string') messages.push({ role: 'user', content: input });
  else if (Array.isArray(input)) {
    for (const [index, item] of input.entries()) {
      const converted = responsesItemToChat(item, index);
      if (converted) messages.push(converted);
    }
  } else {
    throw bridgeError('input must be a string or array.');
  }
  if (!messages.length) throw bridgeError('Responses request contains no input messages.');

  const result = {
    model: boundedString(source.model, 'model', 512, true),
    messages
  };
  const tools = Array.isArray(source.tools) ? source.tools.map(responsesToolToChat) : undefined;
  if (tools && tools.length) result.tools = tools;
  const toolChoice = toolChoiceToChat(source.tool_choice);
  if (toolChoice !== undefined) result.tool_choice = toolChoice;
  for (const [key, outputKey] of [
    ['temperature', 'temperature'], ['top_p', 'top_p'], ['frequency_penalty', 'frequency_penalty'],
    ['presence_penalty', 'presence_penalty'], ['seed', 'seed'], ['user', 'user'],
    ['parallel_tool_calls', 'parallel_tool_calls'], ['service_tier', 'service_tier']
  ]) copyScalar(source, result, key, outputKey);

  if (source.max_output_tokens !== undefined) {
    result.max_tokens = finiteInteger(source.max_output_tokens, 'max_output_tokens', 1, 1_000_000);
  } else if (source.max_tokens !== undefined) {
    result.max_tokens = finiteInteger(source.max_tokens, 'max_tokens', 1, 1_000_000);
  }
  const responseFormat = responseFormatToChat(source.text);
  if (responseFormat) result.response_format = responseFormat;

  const reasoning = source.reasoning && isPlainObject(source.reasoning)
    ? source.reasoning.effort : source.reasoning_effort;
  if (reasoning !== undefined && options.forwardReasoning !== false) {
    const effort = boundedString(reasoning, 'reasoning.effort', 64, true);
    result.reasoning_effort = effort;
  }
  // Codex always asks for a stream. Allow tests/callers to explicitly disable
  // it for a non-streaming upstream request.
  result.stream = source.stream === undefined ? true : Boolean(source.stream);
  if (source.stream_options && isPlainObject(source.stream_options)) {
    result.stream_options = cloneJson(source.stream_options, 'stream_options');
  }
  if (options.extraBody !== undefined) {
    const extraBody = cloneJson(options.extraBody, 'extraBody');
    for (const [key, value] of Object.entries(extraBody)) {
      if (Object.prototype.hasOwnProperty.call(result, key)) continue;
      result[key] = value;
    }
  }
  payloadSize(result, 'Chat request', options.maxPayloadBytes || DEFAULT_MAX_PAYLOAD_BYTES);
  return result;
}

function usageToResponses(usage) {
  if (!isPlainObject(usage)) return undefined;
  const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens);
  const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens);
  const totalTokens = Number(usage.total_tokens);
  const result = {};
  if (Number.isFinite(inputTokens)) result.input_tokens = inputTokens;
  if (Number.isFinite(outputTokens)) result.output_tokens = outputTokens;
  if (Number.isFinite(totalTokens)) result.total_tokens = totalTokens;
  if (usage.prompt_tokens_details && Number.isFinite(Number(usage.prompt_tokens_details.cached_tokens))) {
    result.input_token_details = { cached_tokens: Number(usage.prompt_tokens_details.cached_tokens) };
  }
  if (usage.completion_tokens_details && Number.isFinite(Number(usage.completion_tokens_details.reasoning_tokens))) {
    result.output_token_details = { reasoning_tokens: Number(usage.completion_tokens_details.reasoning_tokens) };
  }
  return Object.keys(result).length ? result : undefined;
}

function assistantMessageOutput(message, responseId, index = 0) {
  const content = message && message.content;
  const text = typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(part => part && (part.type === 'text' || part.type === 'output_text')).map(part => part.text || '').join('')
    : '';
  const item = {
    id: `${responseId}-msg-${index}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }]
  };
  return { item, text };
}

function chatResponseToResponses(response, options = {}) {
  assertPlainObject(response, 'Chat response');
  const source = cloneJson(response, 'Chat response');
  const responseId = boundedString(source.id, 'Chat response.id', 512) || `resp_bridge_${Date.now().toString(36)}`;
  const model = boundedString(source.model, 'Chat response.model', 512) || options.model || 'unknown';
  const choices = Array.isArray(source.choices) ? source.choices : [];
  const output = [];
  let outputText = '';
  for (const [index, choice] of choices.entries()) {
    if (!isPlainObject(choice) || !isPlainObject(choice.message)) continue;
    const message = choice.message;
    const assistant = assistantMessageOutput(message, responseId, index);
    if (assistant.text || !message.tool_calls?.length) {
      output.push(assistant.item);
      outputText += assistant.text;
    }
    if (Array.isArray(message.tool_calls)) {
      for (const [toolIndex, toolCall] of message.tool_calls.entries()) {
        if (!isPlainObject(toolCall) || !isPlainObject(toolCall.function)) continue;
        const callId = boundedString(toolCall.id, `choices[${index}].message.tool_calls[${toolIndex}].id`, 512)
          || `${responseId}-call-${toolIndex}`;
        output.push({
          id: callId,
          type: 'function_call',
          status: 'completed',
          call_id: callId,
          name: boundedString(toolCall.function.name, 'tool call name', 512, true),
          arguments: boundedString(toolCall.function.arguments, 'tool call arguments', 8 * 1024 * 1024)
        });
      }
    }
  }
  const result = {
    id: responseId,
    object: 'response',
    created_at: Number.isFinite(Number(source.created)) ? Number(source.created) : Math.floor(Date.now() / 1000),
    status: 'completed',
    model,
    output,
    output_text: outputText
  };
  const usage = usageToResponses(source.usage);
  if (usage) result.usage = usage;
  if (source.system_fingerprint) result.metadata = { system_fingerprint: source.system_fingerprint };
  payloadSize(result, 'Responses response', options.maxPayloadBytes || DEFAULT_MAX_PAYLOAD_BYTES);
  return result;
}

function sseEncode(eventType, payload) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return `event: ${eventType}\ndata: ${data}\n\n`;
}

function parseSseEvents(text, options = {}) {
  const source = boundedString(text, 'SSE text', options.maxSseBytes || DEFAULT_MAX_PAYLOAD_BYTES);
  const events = [];
  let eventName = '';
  let dataLines = [];
  let lineBytes = 0;
  const flush = () => {
    if (!dataLines.length && !eventName) return;
    const data = dataLines.join('\n');
    events.push({ event: eventName || 'message', data });
    eventName = '';
    dataLines = [];
    lineBytes = 0;
  };
  for (const line of source.split(/\r?\n/)) {
    lineBytes += Buffer.byteLength(line, 'utf8');
    if (lineBytes > (options.maxSseLineBytes || DEFAULT_MAX_SSE_LINE_BYTES)) throw bridgeError('SSE event exceeds the line-size limit.', 400, 'sse_too_large');
    if (!line) { flush(); continue; }
    if (line.startsWith(':')) continue;
    const separator = line.indexOf(':');
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  }
  flush();
  return events;
}

function initialResponseEnvelope(id, model, options = {}) {
  return {
    id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'in_progress',
    model: model || options.model || 'unknown',
    output: [],
    output_text: '',
    parallel_tool_calls: true,
    tools: [],
    metadata: {}
  };
}

/**
 * Convert parsed Chat Completions SSE events into Responses SSE event strings.
 * This function is stateless and useful for buffered fixtures. For network
 * streaming use createChatSseTransformer(), which retains partial SSE lines.
 */
function chatSseEventsToResponses(events, options = {}) {
  if (!Array.isArray(events)) throw bridgeError('Chat SSE events must be an array.');
  const responseId = options.responseId || `resp_bridge_${Date.now().toString(36)}`;
  const model = options.model || '';
  const response = initialResponseEnvelope(responseId, model, options);
  const outputItems = [];
  const textBuffers = new Map();
  const toolBuffers = new Map();
  const emitted = [];
  let sawCreated = false;
  let completed = false;
  const emit = (event, payload) => emitted.push(sseEncode(event, { type: event, ...payload }));
  const ensureMessage = () => {
    if (outputItems.some(item => item.type === 'message')) return outputItems.find(item => item.type === 'message');
    const item = { id: `${responseId}-msg-0`, type: 'message', status: 'in_progress', role: 'assistant', content: [] };
    outputItems.push(item);
    response.output = outputItems;
    emit('response.output_item.added', { output_index: outputItems.length - 1, item: cloneJson(item) });
    const part = { type: 'output_text', text: '', annotations: [] };
    item.content.push(part);
    emit('response.content_part.added', { item_id: item.id, output_index: outputItems.length - 1, content_index: 0, part: cloneJson(part) });
    textBuffers.set(item.id, '');
    return item;
  };
  for (const event of events) {
    if (!event || typeof event.data !== 'string') continue;
    if (event.data === '[DONE]') {
      completed = true;
      continue;
    }
    let chunk;
    try { chunk = JSON.parse(event.data); }
    catch { continue; }
    if (!isPlainObject(chunk)) continue;
    if (!sawCreated) {
      if (chunk.id) response.id = String(chunk.id);
      if (chunk.model) response.model = String(chunk.model);
      emit('response.created', { response: cloneJson(response) });
      sawCreated = true;
    }
    if (chunk.model) response.model = String(chunk.model);
    if (isPlainObject(chunk.usage)) response.usage = usageToResponses(chunk.usage) || response.usage;
    const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
    const delta = choice && isPlainObject(choice.delta) ? choice.delta : undefined;
    if (delta) {
      if (delta.content !== undefined && delta.content !== null) {
        const item = ensureMessage();
        const value = String(delta.content);
        const index = outputItems.indexOf(item);
        const previous = textBuffers.get(item.id) || '';
        textBuffers.set(item.id, previous + value);
        emit('response.output_text.delta', { item_id: item.id, output_index: index, content_index: 0, delta: value, logprobs: [] });
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const toolDelta of delta.tool_calls) {
          if (!isPlainObject(toolDelta)) continue;
          const toolIndex = Number.isInteger(toolDelta.index) ? toolDelta.index : 0;
          let state = toolBuffers.get(toolIndex);
          if (!state) {
            const callId = boundedString(toolDelta.id, 'tool call id', 512) || `${responseId}-call-${toolIndex}`;
            state = { id: callId, call_id: callId, name: '', arguments: '' };
            toolBuffers.set(toolIndex, state);
            const item = { id: state.id, type: 'function_call', status: 'in_progress', call_id: state.call_id, name: '', arguments: '' };
            outputItems.push(item);
            response.output = outputItems;
            emit('response.output_item.added', { output_index: outputItems.length - 1, item: cloneJson(item) });
          }
          const functionPart = isPlainObject(toolDelta.function) ? toolDelta.function : {};
          if (functionPart.name) state.name += String(functionPart.name);
          if (functionPart.arguments) {
            const argumentDelta = String(functionPart.arguments);
            state.arguments += argumentDelta;
            emit('response.function_call_arguments.delta', {
              item_id: state.id, output_index: outputItems.findIndex(item => item.id === state.id), delta: argumentDelta
            });
          }
          const item = outputItems.find(candidate => candidate.id === state.id);
          if (item) { item.name = state.name; item.arguments = state.arguments; }
        }
      }
    }
    if (choice && choice.finish_reason) {
      response.status = choice.finish_reason === 'length' ? 'incomplete' : 'completed';
      response.incomplete_details = choice.finish_reason === 'length' ? { reason: 'max_output_tokens' } : null;
      completed = true;
    }
  }
  if (!sawCreated) {
    emit('response.created', { response: cloneJson(response) });
    sawCreated = true;
  }
  for (const item of outputItems) {
    const outputIndex = outputItems.indexOf(item);
    if (item.type === 'message') {
      const value = textBuffers.get(item.id) || '';
      item.content = [{ type: 'output_text', text: value, annotations: [] }];
      item.status = 'completed';
      emit('response.output_text.done', { item_id: item.id, output_index: outputIndex, content_index: 0, text: value });
      emit('response.content_part.done', { item_id: item.id, output_index: outputIndex, content_index: 0, part: cloneJson(item.content[0]) });
    } else if (item.type === 'function_call') {
      const state = [...toolBuffers.values()].find(candidate => candidate.id === item.id);
      if (state) {
        item.name = state.name;
        item.arguments = state.arguments;
      }
      item.status = 'completed';
      emit('response.function_call_arguments.done', { item_id: item.id, output_index: outputIndex, arguments: item.arguments || '' });
    }
    emit('response.output_item.done', { output_index: outputIndex, item: cloneJson(item) });
  }
  response.output = outputItems;
  response.output_text = outputItems.filter(item => item.type === 'message')
    .flatMap(item => item.content || []).filter(part => part.type === 'output_text').map(part => part.text || '').join('');
  response.status = response.status === 'incomplete' ? 'incomplete' : 'completed';
  emit('response.completed', { response: cloneJson(response) });
  if (!completed) completed = true;
  return { events: emitted, response };
}

function createChatSseTransformer(options = {}) {
  let pending = '';
  let parsedEvents = [];
  let emittedCount = 0;
  const decoder = new TextDecoder();
  const push = chunk => {
    if (chunk instanceof Uint8Array || Buffer.isBuffer(chunk)) pending += decoder.decode(chunk, { stream: true });
    else pending += boundedString(chunk, 'SSE chunk');
    const completeLines = pending.split(/\r?\n/);
    pending = completeLines.pop() || '';
    if (completeLines.length) {
      const parsed = parseSseEvents(`${completeLines.join('\n')}\n`, options);
      parsedEvents.push(...parsed);
    }
    const converted = chatSseEventsToResponses(parsedEvents, options);
    const output = converted.events.slice(emittedCount).join('');
    emittedCount = converted.events.length;
    return output;
  };
  const finish = () => {
    pending += decoder.decode();
    if (pending) {
      parsedEvents.push(...parseSseEvents(`${pending}\n`, options));
      pending = '';
    }
    const converted = chatSseEventsToResponses(parsedEvents, options);
    const output = converted.events.slice(emittedCount).join('');
    emittedCount = converted.events.length;
    return { output, response: converted.response };
  };
  return { push, finish };
}

function resolveUpstreamChatUrl(value) {
  const source = String(value || '').trim();
  if (!source) throw bridgeError('upstreamUrl is required.', 500, 'bridge_configuration_error');
  let url;
  try { url = new URL(source); } catch { throw bridgeError('upstreamUrl must be an absolute HTTP(S) URL.', 500, 'bridge_configuration_error'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw bridgeError('upstreamUrl must use HTTP or HTTPS.', 500, 'bridge_configuration_error');
  if (!/\/chat\/completions\/?$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/chat/completions`;
  }
  return url;
}

function readHttpBody(request, maximum) {
  return new Promise((resolve, reject) => {
    let body = '';
    let bytes = 0;
    let settled = false;
    const fail = error => { if (!settled) { settled = true; reject(error); } };
    request.setEncoding('utf8');
    request.on('data', chunk => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk, 'utf8');
      if (bytes > maximum) {
        fail(bridgeError(`Request body exceeds the ${maximum}-byte limit.`, 413, 'payload_too_large'));
        request.destroy();
        return;
      }
      body += chunk;
    });
    request.on('end', () => { if (!settled) { settled = true; resolve(body); } });
    request.on('error', fail);
  });
}

function safeForwardHeaders(headers, extraHeaders = {}) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (!['authorization', 'api-key', 'x-api-key', 'anthropic-version', 'anthropic-beta', 'openai-organization', 'openai-project'].includes(lower)
      && !lower.startsWith('x-')) continue;
    if (Array.isArray(value)) result[key] = value.join(', ');
    else if (typeof value === 'string') result[key] = value;
  }
  for (const [key, value] of Object.entries(extraHeaders || {})) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (typeof value === 'string') result[key] = value;
  }
  result.accept = 'text/event-stream, application/json';
  result['content-type'] = 'application/json';
  return result;
}

/**
 * Create an optional loopback HTTP bridge. The returned server is not started
 * automatically; call `await bridge.start()` and later `await bridge.stop()`.
 */
function createCodexChatBridge(options = {}) {
  const host = options.host || DEFAULT_HOST;
  const port = options.port === undefined ? 0 : finiteInteger(options.port, 'port', 0, 65535);
  const maxPayloadBytes = options.maxPayloadBytes || DEFAULT_MAX_PAYLOAD_BYTES;
  const timeoutMs = options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
  const upstreamUrl = resolveUpstreamChatUrl(options.upstreamUrl);
  const bridgeToken = options.bridgeToken ? boundedString(options.bridgeToken, 'bridgeToken', 4096, true) : undefined;
  const upstreamHeaders = options.upstreamHeaders ? cloneJson(options.upstreamHeaders, 'upstreamHeaders') : {};
  let server;
  let listeningAddress;

  const respondError = (response, error) => {
    const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 502;
    response.statusCode = statusCode;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ error: { message: String(error.message || error), type: error.code || 'bridge_error' } }));
  };

  const handler = async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', `http://${host}`);
      if (requestUrl.pathname === '/healthz' && request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.method !== 'POST' || !/\/responses\/?$/i.test(requestUrl.pathname)) {
        throw bridgeError('Only POST /responses is available.', 404, 'not_found');
      }
      if (bridgeToken) {
        const authorization = String(request.headers.authorization || '');
        if (authorization !== `Bearer ${bridgeToken}`) throw bridgeError('Invalid bridge credentials.', 401, 'authentication_error');
      }
      const body = await readHttpBody(request, maxPayloadBytes);
      let parsed;
      try { parsed = JSON.parse(body); } catch { throw bridgeError('Request body is not valid JSON.'); }
      const chatRequest = responsesRequestToChat(parsed, options);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let upstreamResponse;
      try {
        const headers = safeForwardHeaders(request.headers, upstreamHeaders);
        if (bridgeToken && !headers.authorization && options.upstreamAuthorization) headers.authorization = options.upstreamAuthorization;
        upstreamResponse = await fetch(upstreamUrl, {
          method: 'POST', headers, body: JSON.stringify(chatRequest), signal: controller.signal
        });
      } finally { clearTimeout(timeout); }
      if (!upstreamResponse.ok) {
        const errorBody = await upstreamResponse.text();
        const error = bridgeError(`Upstream Chat Completions returned HTTP ${upstreamResponse.status}: ${errorBody.slice(0, 1000)}`, upstreamResponse.status, 'upstream_error');
        throw error;
      }
      const contentType = String(upstreamResponse.headers.get('content-type') || '');
      if (chatRequest.stream || contentType.includes('text/event-stream')) {
        response.statusCode = 200;
        response.setHeader('content-type', 'text/event-stream; charset=utf-8');
        response.setHeader('cache-control', 'no-cache');
        response.setHeader('connection', 'keep-alive');
        const transformer = createChatSseTransformer({ model: parsed.model, maxPayloadBytes });
        if (!upstreamResponse.body) throw bridgeError('Upstream returned an empty stream.', 502, 'upstream_error');
        const reader = upstreamResponse.body.getReader();
        try {
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            const output = transformer.push(next.value);
            if (output) response.write(output);
          }
          const final = transformer.finish();
          if (final.output) response.write(final.output);
        } finally { reader.releaseLock(); }
        response.end();
      } else {
        const json = await upstreamResponse.json();
        const converted = chatResponseToResponses(json, { model: parsed.model, maxPayloadBytes });
        response.statusCode = 200;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify(converted));
      }
    } catch (error) {
      if (!response.headersSent) respondError(response, error);
      else response.destroy(error);
    }
  };

  return {
    server: () => server,
    address: () => listeningAddress,
    url: () => listeningAddress ? `http://${host}:${listeningAddress.port}/v1` : undefined,
    async start() {
      if (server) return listeningAddress;
      server = http.createServer((request, response) => { handler(request, response).catch(error => respondError(response, error)); });
      await new Promise((resolve, reject) => {
        const onError = error => { server.removeListener('listening', onListening); reject(error); };
        const onListening = () => { server.removeListener('error', onError); listeningAddress = server.address(); resolve(); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      return listeningAddress;
    },
    async stop() {
      if (!server) return;
      const current = server;
      server = undefined;
      listeningAddress = undefined;
      await new Promise((resolve, reject) => current.close(error => error ? reject(error) : resolve()));
    }
  };
}

module.exports = {
  DEFAULT_MAX_PAYLOAD_BYTES,
  DEFAULT_MAX_SSE_LINE_BYTES,
  responsesRequestToChat,
  chatResponseToResponses,
  parseSseEvents,
  sseEncode,
  chatSseEventsToResponses,
  createChatSseTransformer,
  createCodexChatBridge,
  resolveUpstreamChatUrl
};
