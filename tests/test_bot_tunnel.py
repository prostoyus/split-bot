import pytest

from tunnel import CloudflaredTunnel, TunnelError, parse_tunnel_url

BANNER = (
    "2026-10-19T20:00:00Z INF |  https://quiet-river-1a2b.trycloudflare.com"
    "                                 |"
)


def test_parses_url_from_banner():
    assert parse_tunnel_url(BANNER) == "https://quiet-river-1a2b.trycloudflare.com"


@pytest.mark.parametrize(
    "line",
    [
        "INF Requesting new quick Tunnel on trycloudflare.com...",
        'ERR failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel"',
        "INF Registered tunnel connection connIndex=0",
        "http://plain-http.trycloudflare.com",
        "https://ABC.trycloudflare.com",
    ],
)
def test_ignores_non_tunnel_lines(line):
    assert parse_tunnel_url(line) is None


def test_skips_api_host_but_finds_real_one():
    line = "https://api.trycloudflare.com then https://a-b-c.trycloudflare.com"
    assert parse_tunnel_url(line) == "https://a-b-c.trycloudflare.com"


async def test_missing_executable_gives_russian_error(tmp_path):
    tunnel = CloudflaredTunnel(8080, executable=tmp_path / "nope.exe")
    with pytest.raises(TunnelError, match="Не найден"):
        await tunnel.start()
