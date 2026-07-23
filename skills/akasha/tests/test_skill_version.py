from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
SKILL_DIR = SCRIPTS_DIR.parent
SKILLS_README = SKILL_DIR.parent / "README.md"
sys.path.insert(0, str(SCRIPTS_DIR))

import akasha  # noqa: E402
from api_client import AkashaApiClient, ApiRequestError  # noqa: E402
from credentials import Credentials, save_credentials  # noqa: E402


class SkillAuthenticationInstructionTests(unittest.TestCase):
    def test_agent_resolves_the_skill_directory_for_login(self) -> None:
        instructions = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("从当前 `SKILL.md` 的实际路径解析", instructions)
        self.assertIn("不要让用户查找或猜测 Skill 目录", instructions)

    def test_readme_defers_authentication_until_first_use(self) -> None:
        readme = SKILLS_README.read_text(encoding="utf-8")

        self.assertIn("无需提前查找 Skill 的安装目录", readme)
        self.assertIn("首次使用 Akasha 时", readme)


class JsonResponse:
    def __init__(self, value: object) -> None:
        self._payload = json.dumps(value).encode("utf-8")

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        return None

    def read(self) -> bytes:
        return self._payload


class SkillVersionHeaderTests(unittest.TestCase):
    def test_api_client_sends_the_skill_version_header(self) -> None:
        requests = []

        def transport(request, timeout):
            requests.append(request)
            return JsonResponse({"user": {}, "workspace": {}})

        client = AkashaApiClient(
            base_url="http://localhost:3000",
            api_key="test-key",
            transport=transport,
        )

        client.get_current_user()

        headers = {key.lower(): value for key, value in requests[0].header_items()}
        self.assertEqual(headers["x-akasha-skill-version"], "1.0.0")

    def test_current_user_request_is_cached_for_one_command(self) -> None:
        requests = []

        def transport(request, timeout):
            requests.append(request)
            return JsonResponse({"user": {}, "workspace": {}})

        client = AkashaApiClient(
            base_url="http://localhost:3000",
            api_key="test-key",
            transport=transport,
        )

        client.get_current_user()
        client.get_current_user()

        self.assertEqual(len(requests), 1)


class SkillUpdateNoticeTests(unittest.TestCase):
    def test_query_checks_identity_first_and_surfaces_the_update_notice(self) -> None:
        calls: list[str] = []
        notice = {
            "currentVersion": "1.0.0",
            "latestVersion": "1.1.0",
            "message": "请提示用户升级 Akasha Skill。",
            "upgradeUrl": "https://example.com/akasha-skill",
        }

        class FakeClient:
            def get_current_user(self):
                calls.append("me")
                return {
                    "user": {"id": "user-1"},
                    "workspace": {"id": "workspace-1"},
                    "skillUpdateNotice": notice,
                }

            def query_compiled_wiki(self, question, space_ids):
                calls.append("query")
                return {"answer": "answer", "citations": []}

        with tempfile.TemporaryDirectory() as temp_dir:
            credential_file = Path(temp_dir) / "credentials.env"
            save_credentials(
                Credentials(
                    base_url="http://localhost:3000",
                    api_key="test-key",
                ),
                path=credential_file,
            )
            output = io.StringIO()

            exit_code = akasha.main(
                ["query", "question", "--space-id", "space-1"],
                stdout=output,
                stderr=io.StringIO(),
                credential_file=credential_file,
                client_factory=lambda base_url, api_key: FakeClient(),
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(calls, ["me", "query"])
        self.assertEqual(json.loads(output.getvalue())["skillUpdateNotice"], notice)

    def test_failed_business_request_still_surfaces_the_update_notice(self) -> None:
        notice = {
            "currentVersion": "1.0.0",
            "latestVersion": "1.1.0",
            "message": "请提示用户升级 Akasha Skill。",
            "upgradeUrl": "https://example.com/akasha-skill",
        }

        class FakeClient:
            def get_current_user(self):
                return {"skillUpdateNotice": notice}

            def query_compiled_wiki(self, question, space_ids):
                raise ApiRequestError("Unable to reach the Akasha API.")

        with tempfile.TemporaryDirectory() as temp_dir:
            credential_file = Path(temp_dir) / "credentials.env"
            save_credentials(
                Credentials(
                    base_url="http://localhost:3000",
                    api_key="test-key",
                ),
                path=credential_file,
            )
            error_output = io.StringIO()

            exit_code = akasha.main(
                ["query", "question", "--space-id", "space-1"],
                stdout=io.StringIO(),
                stderr=error_output,
                credential_file=credential_file,
                client_factory=lambda base_url, api_key: FakeClient(),
            )

        self.assertEqual(exit_code, 5)
        lines = error_output.getvalue().splitlines()
        self.assertEqual(lines[0], "Unable to reach the Akasha API.")
        self.assertEqual(json.loads(lines[1])["skillUpdateNotice"], notice)


if __name__ == "__main__":
    unittest.main()
