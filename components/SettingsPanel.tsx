import React, { useState, useEffect } from 'react';
import { GoogleGenAI, Type } from '@google/genai';

export interface Connection {
  id: string;
  name: string;
  description: string;
  url: string;
  type?: 'webhook'; // Discriminator
}

export interface McpServer {
  id: string;
  url: string; // The SSE URL
  postUrl: string; // The POST URL
  name: string;
  status: 'connected' | 'error';
  tools: any[]; // Cached tool definitions
  type?: 'mcp'; // Discriminator
  useCredentials?: boolean;
}

export interface AppSettings {
  voice: string;
  emotion: boolean;
  connections: Connection[];
  mcpServers: McpServer[];
  personality: string;
}

interface SettingsPanelProps {
  isOpen: boolean;
  currentSettings: AppSettings;
  onClose: () => void;
  onSave: (newSettings: AppSettings) => void;
}

const voices = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir'];

// --- Helper to convert JSON Schema type to GenAI Type Enum ---
const mapJsonTypeToGenAiType = (jsonType: string): Type => {
  switch (jsonType) {
    case 'string': return Type.STRING;
    case 'number': return Type.NUMBER;
    case 'integer': return Type.INTEGER;
    case 'boolean': return Type.BOOLEAN;
    case 'array': return Type.ARRAY;
    case 'object': return Type.OBJECT;
    default: return Type.STRING;
  }
};

const convertMcpToolToGemini = (mcpTool: any) => {
  const parameters = {
    type: Type.OBJECT,
    properties: {},
    required: mcpTool.inputSchema?.required || []
  };

  if (mcpTool.inputSchema?.properties) {
    Object.entries(mcpTool.inputSchema.properties).forEach(([key, prop]: [string, any]) => {
      // @ts-ignore
      parameters.properties[key] = {
        type: mapJsonTypeToGenAiType(prop.type),
        description: prop.description || ''
      };
    });
  }

  return {
    name: mcpTool.name,
    description: mcpTool.description,
    parameters: parameters
  };
};

// --- Test Modal Component ---
const TestModal: React.FC<{
  target: Connection | McpServer | null;
  onClose: () => void;
}> = ({ target, onClose }) => {
  const [isTesting, setIsTesting] = useState(false);
  const [result, setResult] = useState<{ request: object; response: string; error?: string } | null>(null);
  const [customPrompt, setCustomPrompt] = useState('salut');

  useEffect(() => {
    if (target && !('postUrl' in target)) {
      handleTest();
    }
  }, [target]);

  const handleTest = async () => {
    if (!target) return;
    setIsTesting(true);
    setResult(null);

    let es: EventSource | null = null;
    try {
      if ('postUrl' in target) {
        const mcpServer = target as McpServer;

        // --- 1. OPEN SSE ---
        const discovery = await new Promise<{ postUrl: string, es: EventSource }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (newEs) newEs.close();
            reject(new Error("Test Timeout: Could not connect (120s)."));
          }, 120000);

          let newEs: EventSource | null = null;
          try {
            newEs = new EventSource(mcpServer.url, { withCredentials: mcpServer.useCredentials });
            newEs.addEventListener('endpoint', (event) => {
              clearTimeout(timeout);
              const base = new URL(mcpServer.url, window.location.href);
              let postUrl = new URL(event.data, base).toString();
              if (mcpServer.url.startsWith('/') && postUrl.startsWith('http')) {
                const urlObj = new URL(postUrl);
                postUrl = urlObj.pathname + urlObj.search;
              }
              resolve({ postUrl, es: newEs! });
            });
            newEs.onerror = () => {
              clearTimeout(timeout);
              reject(new Error("SSE Test Connection failed."));
            };
          } catch (e) { reject(e); }
        });

        es = discovery.es;
        const postEndpoint = discovery.postUrl;

        // --- Persistent Listener for Test ---
        const responses = new Map<number, any>();
        const waiters = new Map<number, { resolve: (d: any) => void, reject: (e: Error) => void, timer: number }>();

        const listener = (ev: MessageEvent) => {
          console.log(`[Test SSE Debug]`, ev.data);
          try {
            const data = JSON.parse(ev.data);
            if (data.id !== undefined) {
              const waiter = waiters.get(data.id);
              if (waiter) {
                clearTimeout(waiter.timer);
                waiters.delete(data.id);
                if (data.error) waiter.reject(new Error(data.error.message));
                else waiter.resolve(data);
              } else responses.set(data.id, data);
            }
          } catch (e) { }
        };
        es.addEventListener('message', listener);

        const wait = (id: number) => {
          if (responses.has(id)) {
            const d = responses.get(id);
            responses.delete(id);
            return Promise.resolve(d);
          }
          return new Promise((res, rej) => {
            const t = window.setTimeout(() => {
              waiters.delete(id);
              rej(new Error(`Timeout waiting for ID ${id}`));
            }, 120000);
            waiters.set(id, { resolve: res, reject: rej, timer: t });
          });
        };
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        // --- 2. HANDSHAKE ---
        const fetchOpts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: mcpServer.useCredentials ? ('include' as RequestCredentials) : ('same-origin' as RequestCredentials),
        };

        const initId = Date.now();
        await fetch(postEndpoint, {
          ...fetchOpts,
          body: JSON.stringify({
            jsonrpc: "2.0", method: "initialize", id: initId,
            params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "1" } }
          })
        });
        await wait(initId);
        await sleep(1000);

        await fetch(postEndpoint, {
          ...fetchOpts,
          body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
        });
        await sleep(1000);

        // --- 3. EXECUTE TEST (Request Tool Call OR List) ---
        const testId = initId + 1;
        let requestBody: any;

        // If user entered a message, try calling send_message
        if (customPrompt && customPrompt.trim() !== 'salut' && customPrompt.trim() !== '') {
          requestBody = {
            jsonrpc: "2.0",
            method: "tools/call",
            id: testId,
            params: {
              name: "send_message",
              arguments: { message: customPrompt }
            }
          };
        } else {
          requestBody = { jsonrpc: "2.0", method: "tools/list", id: testId, params: {} };
        }

        setResult({ request: requestBody, response: `Handshake OK. Sending ${requestBody.method}...` });

        await fetch(postEndpoint, { ...fetchOpts, body: JSON.stringify(requestBody) });
        const finalResponse = await wait(testId);

        setResult({ request: requestBody, response: JSON.stringify(finalResponse.result || finalResponse, null, 2) });
        es.removeEventListener('message', listener);
      }
      else {
        // Webhook logic remains the same
        const connection = target as Connection;
        const requestBody = { query: customPrompt };

        const response = await fetch(connection.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        const responseText = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${responseText}`);
        setResult({ request: requestBody, response: responseText });
      }
    } catch (error: any) {
      setResult({
        request: {},
        response: '',
        error: error.message || 'An unknown error occurred.',
      });
    } finally {
      if (es) es.close();
      setIsTesting(false);
    }
  };

  if (!target) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50 p-4">
      <div className="bg-white text-gray-900 rounded-lg shadow-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-semibold mb-4 text-gray-800">Testing '{target.name}'</h3>

        <div className="mb-4">
          <label className="block text-sm font-medium text-gray-700 mb-1">Test Payload</label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={customPrompt}
              onChange={(e) => setCustomPrompt(e.target.value)}
              className="flex-grow p-2 border border-gray-300 rounded-md shadow-sm"
            />
            <button onClick={handleTest} disabled={isTesting}
              className="bg-black text-white px-4 rounded-md hover:bg-gray-800 disabled:bg-gray-400">
              {isTesting ? 'Sending...' : 'Send'}
            </button>
          </div>
        </div>

        {result && (
          <div className="space-y-4 border-t border-gray-200 pt-4">
            <div>
              <h4 className="font-semibold text-gray-700">Request:</h4>
              <pre className="bg-gray-100 p-2 rounded-md text-xs text-gray-800 overflow-x-auto whitespace-pre-wrap max-h-32">
                {JSON.stringify(result.request, null, 2)}
              </pre>
            </div>
            <div>
              <h4 className="font-semibold text-gray-700">Response:</h4>
              {result.error ? (
                <pre className="bg-red-50 border border-red-200 p-2 rounded-md text-xs text-red-800 overflow-x-auto whitespace-pre-wrap">
                  <span className="font-semibold">Error:</span> {result.error}
                </pre>
              ) : (
                <pre className="bg-green-50 border border-green-200 p-2 rounded-md text-xs text-green-900 overflow-x-auto whitespace-pre-wrap max-h-60">
                  {result.response || '(Empty Response)'}
                </pre>
              )}
            </div>
          </div>
        )}
        <button onClick={onClose} className="mt-6 border border-gray-300 py-2 px-4 rounded-md hover:bg-gray-100 w-full">
          Close
        </button>
      </div>
    </div>
  );
};

// --- Main Settings Panel Component ---
export const SettingsPanel: React.FC<SettingsPanelProps> = ({
  isOpen,
  currentSettings,
  onClose,
  onSave,
}) => {
  const [settings, setSettings] = useState(currentSettings);

  // Connection State
  const [newConnectionName, setNewConnectionName] = useState('');
  const [newConnectionDescription, setNewConnectionDescription] = useState('');
  const [newConnectionUrl, setNewConnectionUrl] = useState('');
  const [connectionToRemove, setConnectionToRemove] = useState<Connection | McpServer | null>(null);
  const [itemToTest, setItemToTest] = useState<Connection | McpServer | null>(null);

  // MCP State
  const [newMcpUrl, setNewMcpUrl] = useState('');
  const [mcpUseCredentials, setMcpUseCredentials] = useState(false);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [mcpError, setMcpError] = useState('');

  // Auto-Config State
  const [autoConfigUrl, setAutoConfigUrl] = useState('');
  const [autoConfigLoading, setAutoConfigLoading] = useState(false);
  const [autoConfigError, setAutoConfigError] = useState('');

  useEffect(() => {
    setSettings(currentSettings);
  }, [currentSettings, isOpen]);

  const handleSave = () => {
    onSave(settings);
  };

  const handleAddConnection = () => {
    if (newConnectionName && newConnectionDescription && newConnectionUrl) {
      const newConnection: Connection = {
        id: Date.now().toString(),
        name: newConnectionName.trim().replace(/\s+/g, '_'),
        description: newConnectionDescription.trim(),
        url: newConnectionUrl.trim(),
      };
      setSettings((prev) => ({
        ...prev,
        connections: [...prev.connections, newConnection],
      }));
      setNewConnectionName('');
      setNewConnectionDescription('');
      setNewConnectionUrl('');
    }
  };

  const handleAddMcpServer = async () => {
    let sseUrl = newMcpUrl.trim();

    if (!sseUrl) {
      setMcpError("Please enter the MCP SSE URL.");
      return;
    }

    setMcpLoading(true);
    setMcpError('');

    // --- PROXY AUTO-DETECTION ---
    const PROXY_TARGET = 'https://agentzero.tail335dec.ts.net';
    if (sseUrl.startsWith(PROXY_TARGET)) {
      console.log("Detected Tailscale URL, rewriting to proxy path to bypass CORS.");
      sseUrl = sseUrl.replace(PROXY_TARGET, '');
      if (!sseUrl.startsWith('/')) sseUrl = '/' + sseUrl;
    }

    let eventSource: EventSource | null = null;
    let initController: AbortController | null = null;

    try {
      // --- 1. PROTOCOL DISCOVERY & SSE OPEN ---
      const discovery = await new Promise<{ postUrl: string, es: EventSource }>((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (es) es.close();
          reject(new Error("Timeout waiting for 'endpoint' event (30s). Check if the server is starting up."));
        }, 30000); // 30 seconds timeout for discovery

        let es: EventSource | null = null;
        try {
          es = new EventSource(sseUrl, { withCredentials: mcpUseCredentials });
          es.onopen = () => console.log("SSE Connection Opened.");
          es.onerror = (e) => {
            clearTimeout(timeout);
            reject(new Error("EventSource connection error. Ensure the URL is correct and the server is reachable."));
          };

          es.addEventListener('endpoint', (event) => {
            clearTimeout(timeout);
            try {
              const base = new URL(sseUrl, window.location.href);
              let postUrl = new URL(event.data, base).toString();
              if (sseUrl.startsWith('/') && postUrl.startsWith('http')) {
                const urlObj = new URL(postUrl);
                postUrl = urlObj.pathname + urlObj.search;
              }
              resolve({ postUrl, es: es! });
            } catch (e) {
              reject(new Error("Invalid endpoint URL from server."));
            }
          });
        } catch (e: any) {
        }
      });

      eventSource = discovery.es;
      const postEndpoint = discovery.postUrl;
      console.log("[Handshake] Discovery Successful. POST URL:", postEndpoint);

      // --- MESSAGE TRACKER (Prevents missing async responses) ---
      const mcpResponses = new Map<number, any>();
      const mcpWaiters = new Map<number, { resolve: (data: any) => void, reject: (e: Error) => void, timer: number }>();

      const sseListener = (ev: MessageEvent) => {
        console.log(`[SSE Raw Message]`, ev.data);
        try {
          const data = JSON.parse(ev.data);
          if (data.id !== undefined) {
            const waiter = mcpWaiters.get(data.id);
            if (waiter) {
              clearTimeout(waiter.timer);
              mcpWaiters.delete(data.id);
              if (data.error) waiter.reject(new Error(`MCP Server Error: ${data.error.message || JSON.stringify(data.error)}`));
              else waiter.resolve(data);
            } else {
              mcpResponses.set(data.id, data);
            }
          }
        } catch (e) {
          console.warn("[SSE Warning] Non-JSON or malformed message:", ev.data);
        }
      };
      eventSource.addEventListener('message', sseListener);

      const waitForId = (id: number) => {
        const alreadyReceived = mcpResponses.get(id);
        if (alreadyReceived) {
          mcpResponses.delete(id);
          return Promise.resolve(alreadyReceived);
        }
        return new Promise((resolve, reject) => {
          const timer = window.setTimeout(() => {
            mcpWaiters.delete(id);
            reject(new Error(`Timeout waiting for SSE response ID ${id} (120s)`));
          }, 120000);
          mcpWaiters.set(id, { resolve, reject, timer });
        });
      };

      const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

      // --- 2. HANDSHAKE (Initialize) ---
      const fetchOptions: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: mcpUseCredentials ? 'include' : 'same-origin',
      };

      const initId = Date.now();
      console.log(`[Handshake] Step 1: Sending initialize (ID: ${initId})...`);
      const initRes = await fetch(postEndpoint, {
        ...fetchOptions,
        body: JSON.stringify({
          jsonrpc: "2.0", method: "initialize", id: initId,
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "gemini-live-web", version: "1.0.0" }
          }
        })
      });
      console.log(`[Handshake] Initialize request status: ${initRes.status}`);

      const initData = await waitForId(initId);
      console.log("[Handshake] Step 1 COMPLETE. Received server capabilities.");

      await sleep(2000); // Wait 2s like the terminal script

      // Step 2: Initialized notification
      console.log("[Handshake] Step 2: Sending 'notifications/initialized'...");
      const notifRes = await fetch(postEndpoint, {
        ...fetchOptions,
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        })
      });
      console.log(`[Handshake] Notification status: ${notifRes.status}`);

      await sleep(2000); // Wait 2s like the terminal script

      // --- 3. FETCH TOOLS ---
      const toolsId = initId + 1;
      console.log(`[Handshake] Step 3: Requesting tools list (ID: ${toolsId})...`);
      const toolsPostRes = await fetch(postEndpoint, {
        ...fetchOptions,
        body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list", id: toolsId, params: {} })
      });
      console.log(`[Handshake] tools/list request status: ${toolsPostRes.status}`);

      const toolsData = await waitForId(toolsId);
      const toolsList = toolsData.result?.tools || [];
      console.log(`[Handshake] SUCCESS! Found ${toolsList.length} tools.`);

      const convertedTools = toolsList.map(convertMcpToolToGemini);

      const newServer: McpServer = {
        id: Date.now().toString(),
        url: sseUrl,
        postUrl: postEndpoint,
        name: `Agent Zero (${toolsList.length} tools)`,
        status: 'connected',
        tools: convertedTools,
        useCredentials: mcpUseCredentials,
      };

      setSettings(prev => ({ ...prev, mcpServers: [...(prev.mcpServers || []), newServer] }));
      setNewMcpUrl('');
      if (eventSource) eventSource.close();

    } catch (e: any) {
      console.error("MCP Connection Failed", e);
      setMcpError(e.message);
      if (eventSource) eventSource.close();
    } finally {
      setMcpLoading(false);
    }
  };

  const handleRemoveMcp = (id: string) => {
    setSettings(prev => ({
      ...prev,
      mcpServers: prev.mcpServers.filter(s => s.id !== id)
    }));
    setConnectionToRemove(null);
  };

  const handleAutoConfigure = async () => {
    if (!autoConfigUrl) {
      setAutoConfigError('Please enter a Webhook URL.');
      return;
    }

    setAutoConfigLoading(true);
    setAutoConfigError('');

    try {
      const predefinedQuestion = "What is your purpose and what parameters should I send you in natural language?";
      const webhookResponse = await fetch(autoConfigUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: predefinedQuestion }),
      });

      if (!webhookResponse.ok) {
        throw new Error(`Webhook responded with status: ${webhookResponse.status}`);
      }
      const webhookDescriptionText = await webhookResponse.text();

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const analysisPrompt = `Analyze the following text which describes a tool's function. Extract a short, programmatic function name in camelCase or snake_case (e.g., 'getWeather', 'searchNews') and a concise one-sentence description for an AI to understand when to use this tool. The text is: "${webhookDescriptionText}"`;

      const result = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: analysisPrompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING, description: 'A short, programmatic function name in camelCase or snake_case.' },
              description: { type: Type.STRING, description: 'A concise one-sentence description of the tool\'s purpose.' },
            },
            required: ['name', 'description'],
          },
        },
      });

      const parsedResult = JSON.parse(result.text);

      setNewConnectionName(parsedResult.name);
      setNewConnectionDescription(parsedResult.description);
      setNewConnectionUrl(autoConfigUrl);

    } catch (error: any) {
      console.error('Auto-configuration failed:', error);
      setAutoConfigError(`Auto-configuration failed: ${error.message}`);
    } finally {
      setAutoConfigLoading(false);
    }
  };

  const handleRemoveConnection = (id: string) => {
    setSettings((prev) => ({
      ...prev,
      connections: prev.connections.filter((c) => c.id !== id),
    }));
    setConnectionToRemove(null);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black bg-opacity-60 z-40" onClick={onClose}></div>
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white text-gray-900 shadow-2xl z-50 transform transition-transform duration-300 ease-in-out"
        style={{ transform: isOpen ? 'translateX(0)' : 'translateX(100%)' }}>
        <div className="flex flex-col h-full">
          <header className="p-6 border-b border-gray-200">
            <h2 className="text-xl font-bold text-gray-800">Settings</h2>
          </header>

          <main className="flex-1 p-6 space-y-8 overflow-y-auto">

            {/* --- Voice Settings --- */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="text-lg font-semibold text-gray-700">AI Voice</h3>
              <div className="space-y-2">
                <label htmlFor="voice-select" className="block text-sm font-medium text-gray-600">Select Voice</label>
                <select id="voice-select" value={settings.voice} onChange={(e) => setSettings({ ...settings, voice: e.target.value })}
                  className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-black focus:border-black">
                  {voices.map((v) => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="flex items-center">
                <input id="emotion-toggle" type="checkbox" checked={settings.emotion} onChange={(e) => setSettings({ ...settings, emotion: e.target.checked })}
                  className="h-4 w-4 text-black border-gray-300 rounded focus:ring-black" />
                <label htmlFor="emotion-toggle" className="ml-2 block text-sm text-gray-900">Enable emotional tone</label>
              </div>
            </div>

            {/* --- Personality Settings --- */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="text-lg font-semibold text-gray-700">Personality</h3>
              <div className="space-y-2">
                <label htmlFor="personality-prompt" className="block text-sm font-medium text-gray-600">
                  Custom Prompt
                </label>
                <textarea
                  id="personality-prompt"
                  placeholder="e.g., You are a witty pirate captain who tells jokes."
                  value={settings.personality}
                  onChange={(e) => setSettings({ ...settings, personality: e.target.value })}
                  className="w-full p-2 border border-gray-300 rounded-md h-24 shadow-sm focus:ring-black focus:border-black"
                />
              </div>
            </div>


            {/* --- MCP Servers --- */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="text-lg font-semibold text-gray-700">Agent Zero (MCP)</h3>

              {/* Method 1: Manual URL (The reliable method) */}
              <div className="p-4 bg-blue-50 rounded-lg border border-blue-200 space-y-2">
                <div className="flex justify-between items-center">
                  <label htmlFor="mcp-url" className="block text-sm font-medium text-blue-900">MCP SSE URL</label>
                </div>

                <p className="text-xs text-blue-700 mb-2">
                  <strong>Proxy Mode:</strong> Enter <code>/mcp/t-XXXX/sse</code> to use the Vite proxy (avoids CORS). <br />
                  <strong>Direct Mode:</strong> Enter <code>https://...</code> for full URLs.
                </p>

                <div className="space-y-2">
                  <input
                    id="mcp-url"
                    type="url"
                    placeholder="/mcp/t-XXXX/sse"
                    value={newMcpUrl}
                    onChange={(e) => setNewMcpUrl(e.target.value)}
                    className="w-full p-2 border border-blue-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500"
                  />

                  <div className="flex items-center mt-2">
                    <input
                      type="checkbox"
                      id="mcp-creds"
                      checked={mcpUseCredentials}
                      onChange={(e) => setMcpUseCredentials(e.target.checked)}
                      className="h-4 w-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                    />
                    <label htmlFor="mcp-creds" className="ml-2 block text-xs text-gray-700">
                      Include Credentials (Cookies) - Check this if using Tailscale auth without a token in URL.
                    </label>
                  </div>

                  <button onClick={handleAddMcpServer} disabled={mcpLoading}
                    className="w-full bg-blue-600 text-white py-2 px-4 rounded-md hover:bg-blue-700 disabled:bg-blue-300 transition-colors">
                    {mcpLoading ? 'Discovering...' : 'Connect'}
                  </button>
                </div>
              </div>

              {mcpError && (
                <div className="mt-2 p-3 bg-red-50 border border-red-200 rounded-md">
                  <p className="text-sm text-red-600 font-bold">Connection Error</p>
                  <p className="text-sm text-red-800 mt-1 break-all">{mcpError}</p>

                  <div className="mt-3 text-xs text-gray-700 bg-white p-2 rounded border border-gray-200">
                    <p className="font-semibold mb-1"> Troubleshooting:</p>
                    <ul className="list-disc pl-4 space-y-1">
                      <li>If using <strong>Tailscale</strong>, try opening the URL in a new tab first to authenticate.</li>
                      <li>Ensure you copied the <strong>entire</strong> URL from Agent Zero.</li>
                      <li><strong>Critical:</strong> Ensure your Agent Zero server allows CORS. Check that <code>CORS_ORIGINS=*</code> (or includes your web app URL) is set in your server's .env file.</li>
                    </ul>
                  </div>
                </div>
              )}

              {/* MCP List */}
              <div className="space-y-2 mt-2">
                {(!settings.mcpServers || settings.mcpServers.length === 0) ? (
                  <p className="text-sm text-gray-500">No MCP servers connected.</p>
                ) : (
                  settings.mcpServers.map(server => (
                    <div key={server.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-md border border-gray-200">
                      <div className="overflow-hidden">
                        <p className="font-semibold text-gray-800 truncate max-w-[200px]">{server.name}</p>
                        <p className="text-xs text-gray-500 truncate max-w-[200px]">{server.postUrl}</p>
                        <p className="text-xs text-green-600">{server.tools.length} tools available</p>
                      </div>
                      <div className="flex items-center space-x-2 ml-2">
                        <button onClick={() => setItemToTest(server)} className="text-sm text-black hover:underline">
                          Test
                        </button>
                        <button onClick={() => setConnectionToRemove(server)} className="text-sm text-red-600 hover:underline">
                          Remove
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>


            {/* --- Tool Connections (Webhooks) --- */}
            <div className="space-y-4 pt-4 border-t border-gray-200">
              <h3 className="text-lg font-semibold text-gray-700">Tool Connections (Webhooks)</h3>

              {/* --- Add New Connection --- */}
              <div className="p-4 border border-gray-200 rounded-lg space-y-4">
                <h4 className="font-medium text-gray-600">Add New N8N Webhook</h4>

                <div className="p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
                  <label htmlFor="auto-config-url" className="block text-sm font-medium text-gray-600">Auto-configure from Webhook URL</label>
                  <div className="flex space-x-2">
                    <input
                      id="auto-config-url" type="url" placeholder="https://your-n8n-url/webhook/..."
                      value={autoConfigUrl} onChange={(e) => setAutoConfigUrl(e.target.value)}
                      className="flex-grow p-2 border border-gray-300 rounded-md shadow-sm focus:ring-black focus:border-black"
                    />
                    <button onClick={handleAutoConfigure} disabled={autoConfigLoading}
                      className="bg-black text-white py-2 px-4 rounded-md hover:bg-gray-800 disabled:bg-gray-400">
                      {autoConfigLoading ? 'Fetching...' : 'Fetch'}
                    </button>
                  </div>
                  {autoConfigError && <p className="text-sm text-black font-semibold mt-1">{autoConfigError}</p>}
                </div>

                <div className="space-y-3">
                  <input type="text" placeholder="Function Name (e.g. getWeather)" value={newConnectionName} onChange={(e) => setNewConnectionName(e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-black focus:border-black" />
                  <textarea placeholder="Description for AI (e.g. gets the weather for a city)" value={newConnectionDescription} onChange={(e) => setNewConnectionDescription(e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md h-20 focus:ring-black focus:border-black" />
                  <input type="url" placeholder="Webhook URL" value={newConnectionUrl} onChange={(e) => setNewConnectionUrl(e.target.value)}
                    className="w-full p-2 border border-gray-300 rounded-md focus:ring-black focus:border-black" />

                  <button onClick={handleAddConnection} className="w-full bg-black text-white py-2 px-4 rounded-md hover:bg-gray-800">Add Connection</button>
                </div>
              </div>


              {/* Connection List */}
              <div className="space-y-2">
                <h4 className="font-medium text-gray-600">Saved Webhooks</h4>
                {settings.connections.length === 0 ? (
                  <p className="text-sm text-gray-500">No connections added yet.</p>
                ) : (
                  settings.connections.map((conn) => (
                    <div key={conn.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-md border border-gray-200">
                      <div className="flex-1 overflow-hidden">
                        <div className="flex items-center space-x-2">
                          <p className="font-semibold text-gray-800 truncate">{conn.name}</p>
                        </div>
                        <p className="text-sm text-gray-500 truncate">{conn.description}</p>
                      </div>
                      <div className="flex items-center space-x-2 ml-2">
                        <button onClick={() => setItemToTest(conn)} className="text-sm text-black hover:underline">Test</button>
                        <button onClick={() => setConnectionToRemove(conn)} className="text-sm text-black hover:underline">Remove</button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </main>

          <footer className="p-6 border-t border-gray-200">
            <button onClick={handleSave} className="w-full bg-black text-white py-2 px-4 rounded-md hover:bg-gray-800">Save and Close</button>
          </footer>
        </div>
      </div>

      {/* --- Modals --- */}
      {connectionToRemove && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex justify-center items-center z-50">
          <div className="bg-white rounded-lg shadow-xl p-6">
            <h3 className="text-lg font-semibold mb-4">Confirm Removal</h3>
            <p>Are you sure you want to remove the '{connectionToRemove.name}' connection?</p>
            <div className="mt-6 flex justify-end space-x-4">
              <button onClick={() => setConnectionToRemove(null)} className="border border-gray-300 py-2 px-4 rounded-md hover:bg-gray-100">Cancel</button>
              <button onClick={() => {
                if ('tools' in connectionToRemove) handleRemoveMcp(connectionToRemove.id);
                else handleRemoveConnection(connectionToRemove.id);
              }} className="bg-black text-white py-2 px-4 rounded-md hover:bg-gray-800">Remove</button>
            </div>
          </div>
        </div>
      )}
      {itemToTest && <TestModal target={itemToTest} onClose={() => setItemToTest(null)} />}
    </>
  );
};