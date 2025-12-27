import requests
import json
import time

# A2A Protocol Test Client
# Target URL - assuming the base agent URL without /sse
# If the user provided URL is .../sse, we probably need the parent or a sibling endpoint.
# But for now, let's try the same tokenized path but without /sse logic likely.
# Note: The user said "works always with the URL", so we use the base URL.

BASE_URL = "https://agentzero.tail335dec.ts.net/mcp/t-5POpxyz_8MCYSMJO"

def test_a2a_handshake(url):
    print(f"Testing A2A Connection to: {url}")
    headers = {"Content-Type": "application/json"}
    
    # 1. Probe with GET (Check for Agent Card or info)
    try:
        print("[GET] Probing URL...")
        r = requests.get(url, verify=False, timeout=10)
        print(f"[GET] Status: {r.status_code}")
        print(f"[GET] Content: {r.text[:200]}...")
    except Exception as e:
        print(f"[GET] Failed: {e}")

    # 2. Try JSON-RPC Initialize (Standard MCP/A2A handshake)
    # A2A might use different method names, but let's try standard first as fallbac/assumption.
    print(f"\n[POST] Sending initialize...")
    init_payload = {
        "jsonrpc": "2.0",
        "method": "initialize",
        "id": 1,
        "params": {
            "protocolVersion": "2024-11-05", # Or A2A specific version
            "capabilities": {},
            "clientInfo": {"name": "test-a2a", "version": "1.0"}
        }
    }
    
    try:
        r1 = requests.post(url, json=init_payload, headers=headers, verify=False, timeout=10)
        print(f"[POST] Initialize Status: {r1.status_code}")
        print(f"[POST] Body: {r1.text}")
        
        if r1.status_code == 200:
            # 3. List Tools/Tasks
            # If A2A, maybe 'agent/capabilities' or 'tools/list'
            print(f"\n[POST] Sending tools/list...")
            tools_payload = { "jsonrpc": "2.0", "method": "tools/list", "id": 2, "params": {} }
            r2 = requests.post(url, json=tools_payload, headers=headers, verify=False, timeout=10)
            print(f"[POST] Tools List Status: {r2.status_code}")
            print(f"[POST] Body: {r2.text}")
            
    except Exception as e:
        print(f"[POST] Failed: {e}")

if __name__ == "__main__":
    test_a2a_handshake(BASE_URL)
