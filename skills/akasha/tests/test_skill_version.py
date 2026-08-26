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
from api_client import (  # noqa: E402
    AkashaApiClient,
    ApiConfigurationError,
    ApiRequestError,
)
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


class SkillCurrentCapabilitiesInstructionTests(unittest.TestCase):
    def test_skill_uses_trusted_answer_evidence_and_acl_authorized_page_url(self) -> None:
        instructions = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("answerMode", instructions)
        self.assertIn("citationEvidence", instructions)
        self.assertIn("retrievedSources", instructions)
        self.assertIn("citation get <PAGE_URL>", instructions)
        self.assertIn("不要求该地址来自知识问答", instructions)

    def test_skill_allows_shared_page_writes_only_through_page_permissions(self) -> None:
        instructions = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("公共/共享空间只要该用户有编辑权限即可写入", instructions)
        self.assertIn("`citation get` 返回 403 时立即停止", instructions)
        self.assertIn("服务端按 API Key 所属用户的空间和 Page 权限校验", instructions)

    def test_skill_documents_page_attachment_commands(self) -> None:
        instructions = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn("page attachment upload <PAGE_ID>", instructions)
        self.assertIn("page attachment replace", instructions)
        self.assertIn("page attachment download <ATTACHMENT_ID>", instructions)
        self.assertIn("支持常规 Page 附件", instructions)

    def test_api_reference_documents_the_citation_page_contract(self) -> None:
        api_reference = (SKILL_DIR / "references" / "api.md").read_text(
            encoding="utf-8"
        )
        metadata = (SKILL_DIR / "agents" / "openai.yaml").read_text(
            encoding="utf-8"
        )

        self.assertIn("POST /api/llm-wiki/citation-page", api_reference)
        self.assertIn('"pageUrl": "/p/page-slug"', api_reference)
        self.assertIn("## 目录", api_reference)
        self.assertIn("## 常见错误", (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8"))
        self.assertIn("$akasha", metadata)


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
        self.assertEqual(headers["x-akasha-skill-version"], "1.3.0")

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

    def test_citation_page_client_posts_the_internal_page_url_unchanged(self) -> None:
        requests = []

        def transport(request, timeout):
            requests.append(request)
            return JsonResponse(
                {
                    "pageId": "page-1",
                    "spaceId": "space-1",
                    "title": "Kafka Guide",
                    "url": "/p/abcdefghij",
                    "content": "# Kafka Guide",
                }
            )

        client = AkashaApiClient(
            base_url="http://localhost:3000",
            api_key="test-key",
            transport=transport,
        )

        result = client.get_citation_page("/p/abcdefghij")

        self.assertEqual(result["pageId"], "page-1")
        self.assertEqual(
            requests[0].full_url,
            "http://localhost:3000/api/llm-wiki/citation-page",
        )
        self.assertEqual(
            json.loads(requests[0].data.decode("utf-8")),
            {"pageUrl": "/p/abcdefghij"},
        )

    def test_citation_page_client_rejects_non_internal_page_urls_locally(self) -> None:
        requests = []
        client = AkashaApiClient(
            base_url="http://localhost:3000",
            api_key="test-key",
            transport=lambda request, timeout: requests.append(request),
        )

        with self.assertRaises(ApiConfigurationError):
            client.get_citation_page("https://example.com/p/kafka-guide")

        self.assertEqual(requests, [])


class LatestKnowledgeQueryTests(unittest.TestCase):
    def test_query_preserves_current_trusted_answer_fields(self) -> None:
        class FakeClient:
            def get_current_user(self):
                return {}

            def query_compiled_wiki(self, question, space_ids):
                return {
                    "answer": "Use Kafka.",
                    "answerMode": "knowledge",
                    "citations": [
                        {
                            "sourcePageId": "page-1",
                            "title": "Kafka Guide",
                            "url": "/p/kafka-guide",
                        }
                    ],
                    "citationEvidence": [
                        {
                            "sourcePageId": "page-1",
                            "title": "Kafka Guide",
                            "url": "/p/kafka-guide",
                            "excerpts": [
                                {
                                    "text": "Kafka backs async events.",
                                    "sourceRange": {
                                        "startOffset": 0,
                                        "endOffset": 25,
                                    },
                                    "quoteHash": "sha256:evidence",
                                }
                            ],
                        }
                    ],
                    "retrievedSources": [
                        {
                            "sourcePageId": "page-1",
                            "title": "Kafka Guide",
                            "url": "/p/kafka-guide",
                        }
                    ],
                    "snippets": [{"text": "internal retrieval payload"}],
                    "warnings": [],
                    "completenessNotice": "Bounded knowledge context.",
                }

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
                ["query", "How is Kafka used?", "--space-id", "space-1"],
                stdout=output,
                stderr=io.StringIO(),
                credential_file=credential_file,
                client_factory=lambda base_url, api_key: FakeClient(),
            )

        result = json.loads(output.getvalue())
        self.assertEqual(exit_code, 0)
        self.assertEqual(result["answerMode"], "knowledge")
        self.assertEqual(result["citationEvidence"][0]["excerpts"][0]["text"], "Kafka backs async events.")
        self.assertEqual(result["retrievedSources"][0]["url"], "/p/kafka-guide")
        self.assertNotIn("snippets", result)


class CitationPageCliTests(unittest.TestCase):
    def test_citation_get_checks_identity_then_reads_the_internal_page_url(self) -> None:
        calls: list[object] = []

        class FakeClient:
            def get_current_user(self):
                calls.append("me")
                return {}

            def get_citation_page(self, page_url):
                calls.append(("citation", page_url))
                return {
                    "pageId": "page-1",
                    "spaceId": "space-1",
                    "title": "Kafka Guide",
                    "url": "/p/kafka-guide",
                    "content": "# Kafka Guide\n\nUse Kafka.",
                    "updatedAt": "2026-07-29T00:00:00.000Z",
                }

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
                ["citation", "get", "/p/kafka-guide"],
                stdout=output,
                stderr=io.StringIO(),
                credential_file=credential_file,
                client_factory=lambda base_url, api_key: FakeClient(),
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(calls, ["me", ("citation", "/p/kafka-guide")])
        self.assertEqual(
            json.loads(output.getvalue()),
            {
                "pageId": "page-1",
                "spaceId": "space-1",
                "title": "Kafka Guide",
                "url": "/p/kafka-guide",
                "content": "# Kafka Guide\n\nUse Kafka.",
                "updatedAt": "2026-07-29T00:00:00.000Z",
            },
        )

    def test_citation_get_accepts_an_empty_page_body(self) -> None:
        class FakeClient:
            def get_current_user(self):
                return {}

            def get_citation_page(self, page_url):
                return {
                    "pageId": "page-empty",
                    "spaceId": "space-1",
                    "title": "Empty Page",
                    "url": page_url,
                    "content": "",
                    "updatedAt": "2026-07-29T00:00:00.000Z",
                }

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
            error_output = io.StringIO()
            exit_code = akasha.main(
                ["citation", "get", "/p/empty-page"],
                stdout=output,
                stderr=error_output,
                credential_file=credential_file,
                client_factory=lambda base_url, api_key: FakeClient(),
            )

        self.assertEqual(exit_code, 0)
        self.assertEqual(error_output.getvalue(), "")
        self.assertEqual(json.loads(output.getvalue())["content"], "")


class SkillUpdateNoticeTests(unittest.TestCase):
    def test_query_checks_identity_first_and_surfaces_the_update_notice(self) -> None:
        calls: list[str] = []
        notice = {
            "currentVersion": "1.0.0",
            "latestVersion": "1.2.0",
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
            "latestVersion": "1.2.0",
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
