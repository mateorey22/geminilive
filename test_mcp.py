import requests
import json
import threading
import time
from urllib.parse import urljoin

SSE_URL = "https://agentzero.tail335dec.ts.net/mcp/t-5POpxyz_8MCYSMJO/sse"

def listen_sse(url):
    print(f"Connecting to SSE: {url}")
    # Using a session and keeping it open
    with requests.get(url, stream=True, verify=False) as response:
        for line in response.iter_lines():
            if line:
                decoded_line = line.decode('utf-8')
                print(f"[SSE RAW] {decoded_line}")
                if decoded_line.startswith('event: endpoint'):
                    pass # Handled by next data line
                if decoded_line.startswith('data: '):
                    data = decoded_line[6:]
                    # Check if it's an endpoint
                    if 'messages' in data or 'session_id' in data:
                        post_url = urljoin(SSE_URL, data)
                        print(f"[DISCOVERY] Found POST URL: {post_url}")
                        threading.Thread(target=send_handshake, args=(post_url,)).start()
                    else:
                        try:
                            json_data = json.loads(data)
                            print(f"[SSE JSON] Received message with ID: {json_data.get('id')}")
                        except:
                            pass

def send_handshake(post_url):
    time.sleep(1)
    headers = {"Content-Type": "application/json"}
    
    # 1. Initialize
    print(f"\n[POST] Sending initialize...")
    init_payload = {
        "jsonrpc": "2.0", "method": "initialize", "id": 1,
        "params": { "protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"} }
    }
    r1 = requests.post(post_url, json=init_payload, headers=headers, verify=False)
    print(f"[POST] Initialize status: {r1.status_code}, body: {r1.text}")
    
    time.sleep(2)
    
    # 2. Initialized notification
    print(f"\n[POST] Sending notifications/initialized...")
    init_notif = { "jsonrpc": "2.0", "method": "notifications/initialized" }
    r2 = requests.post(post_url, json=init_notif, headers=headers, verify=False)
    print(f"[POST] Notification status: {r2.status_code}")
    
    time.sleep(2)
    
    # 3. Tools List
    print(f"\n[POST] Sending tools/list...")
    tools_payload = { "jsonrpc": "2.0", "method": "tools/list", "id": 2, "params": {} }
    r3 = requests.post(post_url, json=tools_payload, headers=headers, verify=False)
    print(f"[POST] Tools list status: {r3.status_code}, body: {r3.text}")

if __name__ == "__main__":
    listen_sse(SSE_URL)
