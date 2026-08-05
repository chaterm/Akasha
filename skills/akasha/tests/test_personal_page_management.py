from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import tempfile
import unittest


SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
SKILL_DIR = SCRIPTS_DIR.parent
sys.path.insert(0, str(SCRIPTS_DIR))

import akasha  # noqa: E402
from api_client import (  # noqa: E402
    AkashaApiClient,
    PermissionDeniedError,
)
from credentials import Credentials, save_credentials  # noqa: E402


IDENTITY = {
    "user": {"id": "user-1"},
    "workspace": {"id": "workspace-1"},
    "apiAccess": {"personalSpaceId": "space-personal", "policy": "ordinary-user"},
}


def _wrap(value: object) -> bytes:
    return json.dumps({"data": value, "success": True, "status": 200}).encode("utf-8")


class RecordingResponse:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback) -> None:
        return None

    def read(self) -> bytes:
        return self._payload


def _client(routes: dict[str, object], calls: list[tuple[str, dict]]):
    def transport(request, timeout):
        path = request.full_url.split("http://localhost:3000")[-1]
        body = json.loads(request.data.decode("utf-8")) if request.data else {}
        calls.append((path, body))
        return RecordingResponse(_wrap(routes[path]))

    return AkashaApiClient(
        base_url="http://localhost:3000",
        api_key="test-key",
        transport=transport,
    )


def _run_cli(argv, fake_client):
    with tempfile.TemporaryDirectory() as temp_dir:
        credential_file = Path(temp_dir) / "credentials.env"
        save_credentials(
            Credentials(base_url="http://localhost:3000", api_key="test-key"),
            path=credential_file,
        )
        output = io.StringIO()
        error_output = io.StringIO()
        exit_code = akasha.main(
            argv,
            stdout=output,
            stderr=error_output,
            credential_file=credential_file,
            client_factory=lambda base_url, api_key: fake_client,
        )
    return exit_code, output, error_output


class SpaceListClientTests(unittest.TestCase):
    def test_list_marks_the_personal_space(self) -> None:
        calls: list[tuple[str, dict]] = []
        routes = {
            "/api/users/me": IDENTITY,
            "/api/spaces": {
                "items": [
                    {"id": "space-personal", "name": "我的空间", "slug": "me"},
                    {"id": "space-1", "name": "工程", "slug": "eng"},
                ],
                "meta": {"hasNextPage": False},
            },
        }
        client = _client(routes, calls)

        summaries = client.list_space_summaries()

        self.assertEqual(
            summaries,
            [
                {
                    "spaceId": "space-personal",
                    "name": "我的空间",
                    "slug": "me",
                    "isPersonal": True,
                },
                {
                    "spaceId": "space-1",
                    "name": "工程",
                    "slug": "eng",
                    "isPersonal": False,
                },
            ],
        )


class DeleteAndRestoreClientTests(unittest.TestCase):
    def test_delete_checks_ownership_then_soft_deletes_without_permanent_flag(
        self,
    ) -> None:
        calls: list[tuple[str, dict]] = []
        routes = {
            "/api/users/me": IDENTITY,
            "/api/pages/info": {"id": "page-1", "spaceId": "space-personal"},
            "/api/pages/delete": None,
        }
        client = _client(routes, calls)

        result = client.delete_personal_page("page-1")

        self.assertEqual(result, {"pageId": "page-1", "deleted": True})
        info_calls = [c for c in calls if c[0] == "/api/pages/info"]
        delete_calls = [c for c in calls if c[0] == "/api/pages/delete"]
        self.assertEqual(len(info_calls), 1)
        self.assertEqual(delete_calls, [("/api/pages/delete", {"pageId": "page-1"})])
        self.assertNotIn("permanentlyDelete", delete_calls[0][1])

    def test_delete_refuses_a_page_outside_the_personal_space(self) -> None:
        calls: list[tuple[str, dict]] = []
        routes = {
            "/api/users/me": IDENTITY,
            "/api/pages/info": {"id": "page-9", "spaceId": "space-shared"},
        }
        client = _client(routes, calls)

        with self.assertRaises(PermissionDeniedError):
            client.delete_personal_page("page-9")

        self.assertNotIn("/api/pages/delete", [c[0] for c in calls])

    def test_restore_confirms_the_restored_page_is_personal(self) -> None:
        calls: list[tuple[str, dict]] = []
        routes = {
            "/api/users/me": IDENTITY,
            "/api/pages/info": {"id": "page-1", "spaceId": "space-personal"},
            "/api/pages/restore": {"id": "page-1", "spaceId": "space-personal"},
        }
        client = _client(routes, calls)

        result = client.restore_personal_page("page-1")

        self.assertEqual(result, {"pageId": "page-1", "restored": True})


class PersonalPageListClientTests(unittest.TestCase):
    def test_recent_scopes_to_the_personal_space_and_compacts_items(self) -> None:
        calls: list[tuple[str, dict]] = []
        routes = {
            "/api/users/me": IDENTITY,
            "/api/pages/recent": {
                "items": [
                    {
                        "id": "page-1",
                        "spaceId": "space-personal",
                        "title": "雷雨",
                        "updatedAt": "2026-08-01T00:00:00.000Z",
                        "content": "internal",
                    }
                ],
                "meta": {"hasNextPage": False},
            },
        }
        client = _client(routes, calls)

        result = client.list_recent_personal_pages(limit=20)

        recent_call = next(c for c in calls if c[0] == "/api/pages/recent")
        self.assertEqual(recent_call[1]["spaceId"], "space-personal")
        self.assertEqual(
            result["items"],
            [
                {
                    "pageId": "page-1",
                    "title": "雷雨",
                    "updatedAt": "2026-08-01T00:00:00.000Z",
                    "deletedAt": None,
                }
            ],
        )
        self.assertNotIn("content", result["items"][0])

    def test_trash_refuses_items_outside_the_personal_space(self) -> None:
        calls: list[tuple[str, dict]] = []
        routes = {
            "/api/users/me": IDENTITY,
            "/api/pages/trash": {
                "items": [{"id": "page-x", "spaceId": "space-shared", "title": "x"}],
                "meta": {"hasNextPage": False},
            },
        }
        client = _client(routes, calls)

        with self.assertRaises(PermissionDeniedError):
            client.list_deleted_personal_pages(limit=20)

    def test_trash_tolerates_an_empty_response_body(self) -> None:
        calls: list[tuple[str, dict]] = []

        def transport(request, timeout):
            path = request.full_url.split("http://localhost:3000")[-1]
            calls.append(path)
            if path == "/api/users/me":
                return RecordingResponse(_wrap(IDENTITY))
            return RecordingResponse(b"")

        client = AkashaApiClient(
            base_url="http://localhost:3000",
            api_key="test-key",
            transport=transport,
        )

        result = client.list_deleted_personal_pages(limit=20)

        self.assertEqual(result, {"items": [], "meta": {"count": 0, "limit": 20}})


class NewCommandCliTests(unittest.TestCase):
    def test_space_list_checks_identity_then_lists_spaces(self) -> None:
        order: list[str] = []

        class FakeClient:
            def get_current_user(self):
                order.append("me")
                return {}

            def list_space_summaries(self):
                order.append("spaces")
                return [
                    {
                        "spaceId": "space-personal",
                        "name": "我的空间",
                        "slug": "me",
                        "isPersonal": True,
                    }
                ]

        exit_code, output, _ = _run_cli(["space", "list"], FakeClient())

        self.assertEqual(exit_code, 0)
        self.assertEqual(order, ["me", "spaces"])
        payload = json.loads(output.getvalue())
        self.assertEqual(payload["meta"]["count"], 1)
        self.assertTrue(payload["items"][0]["isPersonal"])

    def test_page_delete_reports_the_trashed_page(self) -> None:
        class FakeClient:
            def get_current_user(self):
                return {}

            def delete_personal_page(self, page_id):
                return {"pageId": page_id, "deleted": True}

        exit_code, output, _ = _run_cli(["page", "delete", "page-1"], FakeClient())

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            json.loads(output.getvalue()), {"pageId": "page-1", "deleted": True}
        )

    def test_page_restore_reports_the_restored_page(self) -> None:
        class FakeClient:
            def get_current_user(self):
                return {}

            def restore_personal_page(self, page_id):
                return {"pageId": page_id, "restored": True}

        exit_code, output, _ = _run_cli(["page", "restore", "page-1"], FakeClient())

        self.assertEqual(exit_code, 0)
        self.assertEqual(
            json.loads(output.getvalue()), {"pageId": "page-1", "restored": True}
        )

    def test_page_delete_surfaces_permission_denied_as_exit_code_four(self) -> None:
        class FakeClient:
            def get_current_user(self):
                return {}

            def delete_personal_page(self, page_id):
                raise PermissionDeniedError(
                    "Akasha Skill only manages Pages in the personal space."
                )

        exit_code, _, error_output = _run_cli(
            ["page", "delete", "page-9"], FakeClient()
        )

        self.assertEqual(exit_code, 4)
        self.assertIn("personal space", error_output.getvalue())

    def test_page_recent_and_trash_pass_pagination_through(self) -> None:
        seen: list[tuple[str, dict]] = []

        class FakeClient:
            def get_current_user(self):
                return {}

            def list_recent_personal_pages(self, *, limit, cursor):
                seen.append(("recent", {"limit": limit, "cursor": cursor}))
                return {"items": [], "meta": {"count": 0, "limit": limit}}

            def list_deleted_personal_pages(self, *, limit, cursor):
                seen.append(("trash", {"limit": limit, "cursor": cursor}))
                return {"items": [], "meta": {"count": 0, "limit": limit}}

        recent_code, _, _ = _run_cli(
            ["page", "recent", "--limit", "5"], FakeClient()
        )
        trash_code, _, _ = _run_cli(
            ["page", "trash", "--cursor", "c1"], FakeClient()
        )

        self.assertEqual((recent_code, trash_code), (0, 0))
        self.assertEqual(seen[0], ("recent", {"limit": 5, "cursor": None}))
        self.assertEqual(seen[1], ("trash", {"limit": 20, "cursor": "c1"}))


if __name__ == "__main__":
    unittest.main()
