"""DSCord private federation admission. Pinned and tested with Synapse 1.164.2.

Policy is local authority, never instructions from room content. Each host enforces
its own local users and rooms; remote message history is not rewritten by this module.
"""
import json
import hashlib
import os
import time
import uuid

from synapse.module_api import NOT_SPAM
from synapse.module_api.errors import Codes, SynapseError
from twisted.web.resource import Resource


def domain(user_id):
    return user_id.split(":", 1)[1] if isinstance(user_id, str) and ":" in user_id else None


def acl_host(server):
    return server.split(":", 1)[0]


class GovernanceStatus(Resource):
    isLeaf = True

    def __init__(self, guard):
        super().__init__()
        self.guard = guard

    def render_GET(self, request):
        self.guard.policy()
        request.setHeader(b"Content-Type", b"application/json")
        request.setHeader(b"Cache-Control", b"no-store")
        if self.guard.document["error"]:
            request.setResponseCode(503)
        return json.dumps(self.guard.document).encode("utf-8")


class GovernanceModule:
    def __init__(self, config, api):
        self.api = api
        self.config = config
        self.server = config["server_name"]
        self.boot_id = str(uuid.uuid4())
        with open(__file__, "rb") as stream:
            self.source_hash = hashlib.sha256(stream.read()).hexdigest()
        self.last_status = None
        self.document = {}
        api.register_spam_checker_callbacks(user_may_invite=self.may_invite, user_may_join_room=self.may_join)
        api.register_third_party_rules_callbacks(check_event_allowed=self.check_event, on_create_room=self.on_create)
        api.register_web_resource("/_synapse/client/dscord-governance/status", GovernanceStatus(self))
        self.policy()

    @staticmethod
    def parse_config(config):
        for key in ("server_name", "policy_path", "status_path"):
            if not isinstance(config.get(key), str) or not config[key]:
                raise ValueError("Missing DSCord guard " + key)
        return config

    def policy(self):
        try:
            with open(self.config["policy_path"], encoding="utf-8") as stream:
                policy = json.load(stream)
            if policy["schemaVersion"] != 1 or policy["serverName"] != self.server or not isinstance(policy["revision"], int):
                raise ValueError("Invalid policy identity")
            # Fail closed on missing or malformed configuration, including local operations.
            for key in ("partners", "members", "rooms", "botPolicies"):
                if not isinstance(policy[key], list):
                    raise ValueError("Invalid policy collection")
            revision = policy["revision"]
            error = None
        except (OSError, ValueError, KeyError, TypeError):
            policy = None
            revision = None
            error = "POLICY_UNAVAILABLE"
        status = (revision, error)
        self.document = {"serverName": self.server, "bootId": self.boot_id, "synapseVersion": "1.164.2",
                         "sourceSha256": self.source_hash,
                         "liveRevision": revision, "loadedPartners": self.config.get("loaded_partners", []),
                         "observedAt": int(time.time() * 1000), "error": error}
        if status != self.last_status:
            self.last_status = status
            filename = self.config["status_path"]
            temporary = filename + "." + str(os.getpid()) + ".tmp"
            try:
                with open(temporary, "w", encoding="utf-8") as stream:
                    json.dump(self.document, stream)
                os.chmod(temporary, 0o600)
                os.replace(temporary, filename)
            except OSError:
                self.last_status = None
        return policy

    def partners(self, policy):
        return [row["serverName"] for row in policy["partners"] if row.get("enabled") is True]

    def admitted(self, policy, user):
        return domain(user) == self.server or domain(user) in self.partners(policy) and any(
            row["id"] == user and row.get("enabled") is True for row in policy["members"])

    def rule(self, policy, room):
        return next((row for row in policy["rooms"] if row["roomId"] == room), None)

    def allowed(self, policy, room, user):
        row = self.rule(policy, room)
        return bool(row and row.get("enabled") is True and self.admitted(policy, user)
                    and (user in row.get("memberIds", []) or domain(user) == self.server and row["authority"] == self.server))

    async def may_invite(self, inviter, invitee, room_id):
        policy = self.policy()
        if not policy:
            return Codes.FORBIDDEN
        if domain(inviter) == self.server and domain(invitee) == self.server:
            return NOT_SPAM
        # Both participating servers approve the exact room and external identity.
        if not self.admitted(policy, inviter) or not self.admitted(policy, invitee):
            return Codes.FORBIDDEN
        row = self.rule(policy, room_id)
        if not row or not row.get("enabled"):
            return Codes.FORBIDDEN
        if row["authority"] == self.server:
            return NOT_SPAM if self.allowed(policy, room_id, invitee) else Codes.FORBIDDEN
        return NOT_SPAM if row["authority"] in self.partners(policy) and invitee in row.get("memberIds", []) else Codes.FORBIDDEN

    async def may_join(self, user, room, is_invited):
        policy = self.policy()
        if not policy:
            return Codes.FORBIDDEN
        row = self.rule(policy, room)
        if row:
            return NOT_SPAM if self.allowed(policy, room, user) and (row["authority"] == self.server or is_invited) else Codes.FORBIDDEN
        # Legacy local-only rooms retain their membership behavior. Foreign rooms
        # need an explicit policy even when a user bypasses Core and calls /join.
        state = await self.api.get_room_state(room, [("m.room.create", "")])
        creator = state.get(("m.room.create", ""))
        return NOT_SPAM if creator and domain(creator.sender) == self.server and domain(user) == self.server else Codes.FORBIDDEN

    async def on_create(self, requester, request_content, is_requester_admin):
        policy = self.policy()
        if not policy:
            raise SynapseError(403, "DSCord admission policy unavailable", Codes.FORBIDDEN)
        for target in request_content.get("invite", []):
            if domain(target) != self.server:
                # Register the room rule first, then invite. There is no stable
                # room ID before creation to which an external grant can bind.
                raise SynapseError(403, "Create the room, approve its rule, then invite external members", Codes.FORBIDDEN)
        states = [row for row in request_content.get("initial_state", []) if row.get("type") not in ("m.room.server_acl", "m.room.join_rules")]
        states.extend([{"type": "m.room.server_acl", "state_key": "", "content": {
            "allow": sorted({acl_host(self.server), self.server}), "deny": [], "allow_ip_literals": False}},
            {"type": "m.room.join_rules", "state_key": "", "content": {"join_rule": "invite"}}])
        request_content["initial_state"] = states
        request_content["visibility"] = "private"

    async def check_event(self, event, state_events):
        policy = self.policy()
        # Incoming federated history is governed by Matrix auth; rejecting its
        # messages here would create divergent room DAGs. Revoke through bans.
        if domain(event.sender) != self.server:
            if event.type == "m.room.member" and event.content.get("membership") in ("invite", "join"):
                creator = state_events.get(("m.room.create", ""))
                row = self.rule(policy, event.room_id) if policy else None
                local_authority = row["authority"] == self.server if row else creator and domain(creator.sender) == self.server
                if local_authority:
                    return bool(policy and self.allowed(policy, event.room_id, event.state_key)), None
            return True, None
        if not policy:
            return False, None
        row = self.rule(policy, event.room_id)
        creator = state_events.get(("m.room.create", ""))
        local_room = row["authority"] == self.server if row else not creator or domain(creator.sender) == self.server
        if not local_room and event.type not in ("m.room.member", "m.room.server_acl", "m.room.join_rules", "org.dscord.work_policy"):
            return bool(row and self.allowed(policy, event.room_id, event.sender)), None
        if event.type == "m.room.member":
            membership = event.content.get("membership")
            if membership in ("leave", "ban"):
                return True, None
            if domain(event.state_key) != self.server:
                return self.allowed(policy, event.room_id, event.state_key), None
            if not local_room:
                return self.allowed(policy, event.room_id, event.state_key), None
        if event.type == "m.room.join_rules":
            return event.content.get("join_rule") == "invite", None
        if event.type == "m.room.server_acl":
            # Host patterns enforce the specification. The full local name also
            # satisfies Synapse 1.164.2's validator, which checks the port-bearing
            # local server name without stripping its port.
            permitted = {acl_host(self.server), self.server}
            if row and row.get("enabled"):
                if row["authority"] == self.server or row["authority"] in self.partners(policy):
                    permitted.add(acl_host(row["authority"]))
                    permitted.add(row["authority"])
                for user in row["memberIds"]:
                    if self.admitted(policy, user):
                        permitted.update({acl_host(domain(user)), domain(user)})
            allow = event.content.get("allow", [])
            return bool(allow and set(allow).issubset(permitted) and event.content.get("allow_ip_literals") is False), None
        if event.type == "org.dscord.work_policy":
            if not local_room:
                return False, None
            expected = {"schemaVersion": 1, "roomId": event.room_id,
                        "revision": policy["revision"], "authority": self.server,
                        "issuerId": "@dscord-control:" + self.server,
                        "localMemberAdmission": "matrix-membership",
                        "enabled": bool(row and row.get("enabled")),
                        "botIds": [user for user in row.get("botIds", []) if self.admitted(policy, user)] if row else [],
                        "tools": row.get("tools", []) if row else [],
                        "memberIds": [user for user in row.get("memberIds", []) if self.admitted(policy, user)] if row else []}
            return event.sender == expected["issuerId"] and event.content == expected, None
        return True, None
