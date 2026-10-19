import run


class BrokenDp:
    async def stop_polling(self):
        raise TimeoutError


class BrokenSession:
    async def close(self):
        raise RuntimeError("boom")


class BrokenBot:
    session = BrokenSession()


class FakeTunnel:
    stopped = False

    async def stop(self):
        self.stopped = True


async def test_shutdown_always_stops_tunnel(monkeypatch):
    disposed = []

    async def fake_dispose():
        disposed.append(True)

    async def drain(timeout):
        raise RuntimeError("drain failed")

    monkeypatch.setattr(run.db, "dispose", fake_dispose)
    monkeypatch.setattr(run.notifier, "drain", drain, raising=False)
    tunnel = FakeTunnel()
    await run._shutdown(None, BrokenDp(), [], BrokenBot(), tunnel)
    assert tunnel.stopped
    assert disposed == [True]
