"""The SDK must not treat caller-provided identifiers as URL path segments."""
import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

from langgraph_sdk._async.stream import AsyncThreadStream, _AgentModule
from langgraph_sdk._sync.stream import SyncThreadStream, _SyncAgentModule


def test_sync_stream_encodes_identifiers_before_requests():
    http = SimpleNamespace(get=Mock(return_value={}))
    owner = SimpleNamespace(_closed=False, _headers={}, assistant_id='../admin', thread_id='../secret?x=1', _http=http)
    _SyncAgentModule(owner).get_tree()
    assert http.get.call_args.args[0] == '/assistants/..%2Fadmin/graph'
    SyncThreadStream._fetch_state(owner)
    assert http.get.call_args.args[0] == '/threads/..%2Fsecret%3Fx%3D1/state'


def test_async_stream_encodes_identifiers_before_requests():
    http = SimpleNamespace(get=AsyncMock(return_value={}))
    owner = SimpleNamespace(_closed=False, _headers={}, assistant_id='../admin', thread_id='../secret?x=1', _http=http)
    asyncio.run(_AgentModule(owner).get_tree())
    assert http.get.call_args.args[0] == '/assistants/..%2Fadmin/graph'
    asyncio.run(AsyncThreadStream._fetch_state(owner))
    assert http.get.call_args.args[0] == '/threads/..%2Fsecret%3Fx%3D1/state'
