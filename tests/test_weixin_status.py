from taskboard import _build_weixin_channel_status


class StubDB:
    def __init__(self):
        self.settings = {
            "weixin_enabled": "true",
            "weixin_default_working_dir": "~/repo",
            "weixin_base_url": "https://ilinkai.weixin.qq.com",
            "weixin_account_id": "",
        }

    def get_setting(self, key, default=None):
        return self.settings.get(key, default)


class StubWeixinChannel:
    _running = True

    def get_status_snapshot(self):
        return {
            "configured": True,
            "login_status": "connected",
            "qr_code_url": "",
            "last_error": "",
            "account_id": "wx-live-account",
            "user_id": "user-42",
        }


def test_build_weixin_channel_status_prefers_runtime_account_id():
    status = _build_weixin_channel_status(StubDB(), StubWeixinChannel())

    assert status["enabled"] is True
    assert status["configured"] is True
    assert status["running"] is True
    assert status["account_id"] == "wx-live-account"
    assert status["user_id"] == "user-42"
