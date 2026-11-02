"""Read-only, explicit-scope 3H Lab audit. No product imports, RPC, UI or model.

Inventory reads one approved run/connection's control references and no Session
files. Audit reads only the frozen exact Session IDs. Reports omit message text,
target credentials, claim tokens and context tokens. Generic file/SQLite/hash
helpers are reused from the separately versioned Core audit, never product code.
"""
from __future__ import annotations
import argparse
from collections import Counter
import importlib.util
import io
import json
from pathlib import Path
import re
import sys

_HELPER_PATH = Path(__file__).resolve().with_name('audit-core-host.py')
_spec = importlib.util.spec_from_file_location('shiyu_core_audit_helpers', _HELPER_PATH)
core = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(core)
AuditError = core.AuditError
require, sha, canonical, stable_read, read_db = core.require, core.sha, core.canonical, core.stable_read, core.read_db
native_message_hash = core.native_message_hash
AXES = ('tokens', 'calls', 'effects')
PRESET = 'shiyu-runtime-replyer-v1'
ID = r'[A-Za-z0-9][A-Za-z0-9:._/-]{0,199}'
SESSION_ID = r'[A-Za-z0-9][A-Za-z0-9_-]{0,199}'
INPUT_KEYS = {'eventId', 'channelId', 'actorId', 'type', 'seq', 'bodyHash', 'bodyBytes'}

def identifier(value, pattern=ID):
    return core.safe_id(value, pattern)

def integer(value, low=0, high=2**53-1):
    require(type(value) is int and low <= value <= high, 'INVALID_INTEGER')
    return value

def projection(value):
    """Explicit diagnostic fields only; even unexpected private keys disappear."""
    allowed = set('connectionId runId requestId status version epoch expiresAt channelId kind membersDigest conversationId inputVersion cursor eventId actorId type seq bodyHash bodyBytes replyId anchorEventId inputRefs sendId opId draftOperationId conversationGeneration reservationId mandateId mandateVersion authEpoch action scope state amount observed overrun limits tokens calls effects leaseExpiresAt effectId idempotencyKey payloadHash replayClass maxAttempts attempts receiptId outcome observedAt externalOperationId serviceId mode sessionId eventSeq messageId messageHash userMessageSeq durability textSha256 createdAt updatedAt reasonCode'.split())
    if isinstance(value, dict): return {key: projection(item) for key, item in value.items() if key in allowed}
    if isinstance(value, list):
        require(len(value) <= 256, 'PROJECTION_BOUND')
        return [projection(item) for item in value]
    if isinstance(value, str):
        return value if re.fullmatch(r'[A-Za-z0-9:._/+\-]{0,300}', value) else {'redactedSha256': sha(value.encode())}
    require(value is None or type(value) in (int, float, bool), 'PROJECTION_VALUE')
    return value

def record(value):
    return {'recordSha256': sha(canonical(value).encode()), 'metadata': projection(value)}

def validate_plan(plan, mode):
    require(isinstance(plan, dict) and plan.get('schemaVersion') == 1 and plan.get('phase') == '3H', 'PLAN_SCHEMA')
    for key in ('runId', 'connectionId', 'requestId'): identifier(plan.get(key))
    identifier(plan.get('executionPlanSha256'), r'[a-f0-9]{64}')
    require(isinstance(plan.get('budget'), dict) and set(plan['budget']) == set(AXES), 'PLAN_BUDGET')
    for axis in AXES: integer(plan['budget'][axis])
    channels = plan.get('channelIds')
    require(isinstance(channels, list) and 1 <= len(channels) <= 20 and len(set(channels)) == len(channels), 'PLAN_CHANNELS')
    for item in channels: identifier(item)
    paths = plan.get('paths', {})
    require(set(paths) == {'controlDb', 'sessionRoots'}, 'PLAN_PATHS')
    core.exact_path(paths['controlDb'])
    require(isinstance(paths['sessionRoots'], list) and 1 <= len(paths['sessionRoots']) <= 4 and len(set(paths['sessionRoots'])) == len(paths['sessionRoots']), 'PLAN_ROOTS')
    for root in paths['sessionRoots']: core.exact_path(root, directory=True)
    limits = plan.get('limits', {})
    for key, cap in (('inputs', 200), ('replies', 32), ('sends', 32), ('compressedSessionBytes', 16*1024*1024), ('decodedSessionBytes', 64*1024*1024), ('nativeEventRows', 4096)):
        integer(limits.get(key), 1, cap)
    sessions = plan.get('sessions', [])
    require(isinstance(sessions, list) and len(sessions) <= 20 and len({s.get('sessionId') for s in sessions}) == len(sessions), 'PLAN_SESSION_BOUND')
    for session in sessions:
        require(set(session) == {'sessionId', 'conversationId', 'cwd'}, 'PLAN_SESSION_FIELDS')
        identifier(session['sessionId'], SESSION_ID); identifier(session['conversationId'])
        require(isinstance(session['cwd'], str) and Path(session['cwd']).is_absolute() and '\0' not in session['cwd'], 'PLAN_CWD')
    if 'expectedInputs' in plan:
        require(isinstance(plan['expectedInputs'], list) and len(plan['expectedInputs']) <= limits['inputs'], 'PLAN_INPUT_BOUND')
        for item in plan['expectedInputs']: validate_input(item)
    observations = plan.get('deliveryObservations', [])
    require(isinstance(observations, list) and len(observations) <= limits['sends'], 'PLAN_OBSERVATION_BOUND')
    for observation in observations:
        require(set(observation) == {'eventId', 'channelId', 'opId', 'bodyHash', 'observedAt'}, 'PLAN_OBSERVATION_FIELDS')
        for key in ('eventId', 'channelId', 'opId'): identifier(observation[key])
        identifier(observation['bodyHash'], r'[a-f0-9]{64}')
    if 'deliveryEvidence' in plan:
        require(set(plan['deliveryEvidence']) == {'path', 'sha256'}, 'PLAN_DELIVERY_EVIDENCE')
        identifier(plan['deliveryEvidence']['sha256'], r'[a-f0-9]{64}'); core.exact_path(plan['deliveryEvidence']['path'])
    if 'baseline' in plan:
        require(set(plan['baseline']) == {'path', 'sha256'}, 'PLAN_BASELINE')
        identifier(plan['baseline']['sha256'], r'[a-f0-9]{64}'); core.exact_path(plan['baseline']['path'])

def validate_input(item):
    require(isinstance(item, dict) and set(item) == INPUT_KEYS, 'INPUT_FIELDS')
    for key in ('eventId', 'channelId', 'actorId'): identifier(item[key])
    require(len(item['actorId']) <= 80 and item['actorId'] != 'SHIYU' and re.fullmatch(r'input\.(message|request|query|correction|cancel|memory)', item['type']), 'INPUT_IDENTITY')
    integer(item['seq'], 1); integer(item['bodyBytes'], 1, 16384); identifier(item['bodyHash'], r'[a-f0-9]{64}')

def control_records(plan):
    def query(db):
        def rows(sql, args=(), cap=256):
            result = db.execute(sql, args).fetchmany(cap+1); require(len(result) <= cap, 'CONTROL_ROW_BOUND')
            return [dict(row) for row in result]
        def records(table, column, value, cap=256, json_column='record_json'):
            return [json.loads(row[json_column]) for row in rows(f'SELECT "{json_column}" FROM "{table}" WHERE "{column}"=? ORDER BY rowid', (value,), cap)]
        def one(table, column, value, optional=False):
            values = records(table, column, value, 1); require(len(values) == 1 or optional and not values, 'CONTROL_RECORD_MISSING')
            return values[0] if values else None
        connection = one('shiyu_lab_connections', 'connection_id', plan['connectionId'])
        require(connection.get('connectionId') == plan['connectionId'] and connection.get('runId') == plan['runId'] and connection.get('requestId') == plan['requestId'], 'CONNECTION_IDENTITY')
        require(connection.get('budget') == plan['budget'] and [c['channelId'] for c in connection['channels']] == plan['channelIds'], 'CONNECTION_APPROVAL')
        inputs = records('shiyu_lab_inputs', 'connection_id', plan['connectionId'], plan['limits']['inputs'])
        replies = records('shiyu_lab_replies', 'connection_id', plan['connectionId'], plan['limits']['replies'])
        sends = records('shiyu_lab_sends', 'connection_id', plan['connectionId'], plan['limits']['sends'])
        mandate = one('shiyu_mandates', 'id', connection['mandateId'])
        reservations = records('shiyu_budget_reservations', 'mandate_id', connection['mandateId'], 64)
        usage = []
        for reservation in reservations:
            usage.extend(rows('SELECT id,receipt_hash,result_json FROM shiyu_budget_receipts WHERE reservation_id=? ORDER BY rowid', (reservation['reservationId'],), 8))
        local = []
        for reply in replies:
            matches = records('shiyu_local_reply_inputs', 'input_id', reply['replyId'], 1)
            local.extend(matches)
        effects, attempts, receipts = [], [], []
        for send in sends:
            effects.append(one('shiyu_effects', 'effect_id', send['opId']))
            attempts.extend(records('shiyu_effect_attempts', 'effect_id', send['opId'], 1))
            receipts.extend(records('shiyu_effect_receipts', 'effect_id', send['opId'], 1))
        return {'connection': connection, 'inputs': inputs, 'replies': replies, 'sends': sends, 'mandate': mandate, 'reservations': reservations,
                'budgetReceipts': [{'receiptId': row['id'], 'receiptHash': row['receipt_hash'], 'result': json.loads(row['result_json'])} for row in usage],
                'localReplies': local, 'effects': effects, 'attempts': attempts, 'receipts': receipts}
    return read_db(plan['paths']['controlDb'], query)

def decode_native(raw, limits):
    import zstandard
    with zstandard.ZstdDecompressor().stream_reader(io.BytesIO(raw), read_across_frames=True) as reader:
        decoded = reader.read(limits['decodedSessionBytes']+1)
    require(len(decoded) <= limits['decodedSessionBytes'], 'NATIVE_DECODE_BOUND')
    lines = decoded.splitlines(); require(1 <= len(lines) <= limits['nativeEventRows']+1, 'NATIVE_ROW_BOUND')
    parsed = [json.loads(line) for line in lines]
    require(isinstance(parsed[0], dict) and 'seq' not in parsed[0] and parsed[0].get('agentPreset') == PRESET, 'NATIVE_HEADER')
    return parsed[0], parsed[1:]

def message_text(message, assistant=False):
    require(isinstance(message, dict) and isinstance(message.get('content'), list), 'NATIVE_MESSAGE_CONTENT')
    allowed = {'text','reasoning'} if assistant else {'text'}
    require(message.get('role') == ('assistant' if assistant else 'user') and all(isinstance(part, dict) and part.get('type') in allowed and isinstance(part.get('text'), str) for part in message['content']), 'NATIVE_NON_TEXT_CONTENT')
    # Native full-message hashes still include reasoning. Product completedText
    # projects only text blocks; reasoning is never returned in this report.
    parts = [part['text'] for part in message['content'] if part['type'] == 'text']
    require(parts and any(part.strip() for part in parts), 'NATIVE_TEXT_MISSING')
    return '\n'.join(parts)

def verify_group(prompt, local, refs):
    marker = '\n本轮用户输入：\n'
    require(marker in prompt, 'NATIVE_INPUT_ENVELOPE')
    envelope = prompt.split(marker, 1)[1]
    require(sha(envelope.encode()) == local.get('inputHash'), 'NATIVE_INPUT_HASH')
    remaining = envelope.encode()
    for index, ref in enumerate(refs):
        metadata = {key: ref[key] for key in ('eventId', 'actorId', 'channelId', 'type')}
        header = f'输入 {index+1} 元信息（仅数据）：' + json.dumps(metadata, ensure_ascii=False, separators=(',', ':')) + '\n正文：\n'
        require(remaining.startswith(header.encode()), 'NATIVE_INPUT_IDENTITY')
        remaining = remaining[len(header.encode()):]; body = remaining[:ref['bodyBytes']]
        require(len(body) == ref['bodyBytes'] and sha(body) == ref['bodyHash'], 'NATIVE_INPUT_BODY_HASH')
        body.decode('utf-8'); remaining = remaining[ref['bodyBytes']:]
        if index+1 < len(refs): require(remaining.startswith(b'\n\n'), 'NATIVE_INPUT_SEPARATOR'); remaining = remaining[2:]
    require(not remaining, 'NATIVE_EXTRA_INPUT')

def native_lifecycles(events):
    """Fixed DSH agent-loop turn/step data identities, with no payload projection."""
    rounds, errors = [], []; current = None; step = None; last_turn = 0
    for event in events:
        kind, seq, data = event['type'], event['seq'], event.get('data', {})
        if not isinstance(data, dict): data = {}
        if kind == 'turn/start':
            turn = data.get('turn')
            if current is not None or type(turn) is not int or turn <= last_turn:
                errors.append('NATIVE_TURN_START'); continue
            last_turn = turn; current = {'turn':turn,'start':seq,'steps':[]}; step = None
        elif kind == 'step/start':
            number = data.get('step')
            if current is None or step is not None or type(data.get('turn')) is not int or data.get('turn') != current['turn'] or type(number) is not int or number < 1 or current['steps']:
                errors.append('NATIVE_STEP_START'); continue
            step = {'step':number,'start':seq,'assistants':[]}; current['steps'].append(step)
        elif kind == 'assistant/message':
            if current is None or step is None or type(data.get('turn')) is not int or data.get('turn') != current['turn'] or type(data.get('step')) is not int or data.get('step') != step['step']:
                errors.append('NATIVE_ASSISTANT_LIFECYCLE')
            else: step['assistants'].append(seq)
        elif kind == 'step/end':
            if current is None or step is None or type(data.get('turn')) is not int or data.get('turn') != current['turn'] or type(data.get('step')) is not int or data.get('step') != step['step']:
                errors.append('NATIVE_STEP_END'); continue
            step['end'] = seq; step = None
        elif kind == 'turn/end':
            if current is None or step is not None or type(data.get('turn')) is not int or data.get('turn') != current['turn']:
                errors.append('NATIVE_TURN_END'); continue
            current['end'] = seq; current['completed'] = isinstance(data.get('reason'),dict) and data['reason'].get('kind') == 'completed'
            rounds.append(current); current = None
    if current is not None or step is not None: errors.append('NATIVE_LIFECYCLE_INCOMPLETE')
    return {'rounds':rounds,'issues':sorted(set(errors))}


def collect(plan, mode='audit', expectation='observe'):
    require(mode in ('inventory', 'audit') and expectation in ('observe', 'complete'), 'AUDIT_MODE')
    validate_plan(plan, mode); data = control_records(plan); c = data['connection']; issues = []
    def check(condition, code):
        if not condition and code not in [item['code'] for item in issues]: issues.append({'code': code})
    channels = {v['channelId']: v for v in c['channels']}
    inputs = {v['eventId']: v for v in data['inputs']}; require(len(inputs) == len(data['inputs']), 'DUPLICATE_INPUT')
    for item in inputs.values(): validate_input(item); require(item['channelId'] in channels, 'INPUT_CHANNEL_SCOPE')
    if 'expectedInputs' in plan: check(sorted(data['inputs'], key=lambda x:x['seq']) == sorted(plan['expectedInputs'], key=lambda x:x['seq']), 'EXPECTED_INPUT_MISMATCH')
    reservations = {v['reservationId']: v for v in data['reservations']}; require(len(reservations) == len(data['reservations']), 'DUPLICATE_RESERVATION')
    replies = {v['replyId']: v for v in data['replies']}; sends = {v['opId']: v for v in data['sends']}; effects = {v['effectId']: v for v in data['effects']}
    require(len(replies) == len(data['replies']) and len(sends) == len(data['sends']), 'DUPLICATE_OPERATION')
    mandate = data['mandate']; require(mandate['mandateId'] == c['mandateId'] and mandate['scope'] == 'local-owner' and mandate['issuer'] == 'local-owner' and mandate['limits'] == c['budget'], 'MANDATE_SCOPE')
    require(set(mandate['allowedActions']) == {'lab.reply','lab.message.send'} and mandate['subjectIds'] == ['shiyu-lab-dispatcher'], 'MANDATE_ACTIONS')
    known = set(); required_sessions = {}; anchor_keys = set(); locals_by_reply = {}
    for local in data['localReplies']:
        require(local.get('inputId') in replies and local.get('conversationId') == replies[local['inputId']]['conversationId'] and local.get('scope') == 'local-owner', 'LOCAL_REPLY_SCOPE')
        require(local['inputId'] not in locals_by_reply, 'DUPLICATE_NATIVE_OPERATION'); locals_by_reply[local['inputId']] = local
        for ref in (local.get('nativeBinding'), local.get('contextReceipt'), local.get('assistantRef')):
            if ref and ref.get('sessionId'):
                sid = identifier(ref['sessionId'], SESSION_ID); existing = required_sessions.get(sid)
                require(existing is None or existing == local['conversationId'], 'SESSION_SCOPE_COLLISION'); required_sessions[sid] = local['conversationId']
    for reply in replies.values():
        require(reply['connectionId'] == c['connectionId'] and reply['channelId'] in channels and reply['conversationId'] == channels[reply['channelId']]['conversationId'], 'REPLY_SCOPE')
        refs = reply['inputRefs']; require(1 <= len(refs) <= 8 and sum(ref['bodyBytes'] for ref in refs) <= 16384, 'REPLY_GROUP_BOUND')
        require(all(inputs.get(ref['eventId']) == ref and ref['channelId'] == reply['channelId'] for ref in refs), 'REPLY_INPUT_REFERENCE')
        require([ref['seq'] for ref in refs] == sorted({ref['seq'] for ref in refs}) and refs[-1]['eventId'] == reply['anchorEventId'], 'REPLY_ANCHOR')
        anchor = (reply['channelId'], reply['anchorEventId']); require(anchor not in anchor_keys, 'DUPLICATE_ANCHOR'); anchor_keys.add(anchor)
        p = reply['permit']; require(p['replyId'] == reply['replyId'] and p['connectionId'] == c['connectionId'] and p['anchorEventId'] == reply['anchorEventId'] and p['channelId'] == reply['channelId'], 'REPLY_PERMIT')
        auth = p['authorization']; reservation = reservations.get(auth['reservationId']); require(reservation is not None and all(reservation.get(key) == value for key,value in auth.items()), 'GENERATION_RESERVATION')
        require(auth['mandateId'] == c['mandateId'] and auth['action'] == 'lab.reply' and reservation['amount'] == {'tokens':16384,'calls':1,'effects':0}, 'GENERATION_BUDGET')
        require(auth['scope'] == 'local-owner' and reservation['principalId'] == 'shiyu-lab-dispatcher' and auth['resourceScopes'] and all(resource in mandate['allowedResources'] for resource in auth['resourceScopes']), 'GENERATION_RESOURCE_SCOPE')
        known.add(auth['reservationId'])
    for send in sends.values():
        require(send['connectionId'] == c['connectionId'] and send['replyId'] in replies and send['channelId'] == replies[send['replyId']]['channelId'], 'SEND_SCOPE')
        reply, effect = replies[send['replyId']], effects[send['opId']]; auth = send['authorization']; known.add(auth['reservationId'])
        reservation = reservations.get(auth['reservationId']); require(reservation is not None and all(reservation.get(key) == value for key,value in auth.items()), 'SEND_RESERVATION')
        require(auth['mandateId'] == c['mandateId'] and auth['action'] == 'lab.message.send' and reservation['amount'] == {'tokens':0,'calls':0,'effects':1}, 'SEND_BUDGET')
        require(auth['scope'] == 'local-owner' and reservation['principalId'] == 'shiyu-lab-dispatcher' and auth['resourceScopes'] == reply['permit']['authorization']['resourceScopes'] and all(resource in mandate['allowedResources'] for resource in auth['resourceScopes']), 'SEND_RESOURCE_SCOPE')
        require(effect['idempotencyKey'] == send['opId'] and effect['payloadHash'] == send['bodyHash'] and effect['action'] == 'lab.message.send' and effect['maxAttempts'] == 1 and effect['attempts'] <= 1, 'EFFECT_IDENTITY')
        require(effect['origin'] == {'kind':'dialogue','conversationId':reply['conversationId'],'turnId':reply['replyId'],'conversationGeneration':send['conversationGeneration']}, 'EFFECT_ORIGIN')
        require(effect['resourceScopes'] == auth['resourceScopes'] and effect['authorization']['mandateId'] == c['mandateId'], 'EFFECT_AUTHORITY')
        local = locals_by_reply.get(reply['replyId']); require(local and local['operationId'] == send['draftOperationId'] and local.get('textSha256') == send['bodyHash'], 'SEND_DRAFT_IDENTITY')
        attempts = [a for a in data['attempts'] if a['effectId'] == send['opId']]; require(len(attempts) == effect['attempts'], 'EFFECT_ATTEMPT_COVERAGE')
        if effect.get('currentClaim'):
            require(attempts and all(attempts[-1].get(key) == value for key,value in effect['currentClaim'].items()), 'EFFECT_CLAIM_IDENTITY')
        receipt = [r for r in data['receipts'] if r['effectId'] == send['opId']]
        if effect['status'] == 'succeeded':
            observation = send.get('observation'); require(observation and len(receipt) == 1 and receipt[0]['receiptId'] == effect['receiptId'], 'DELIVERY_RECEIPT_MISSING')
            require(observation['opId'] == send['opId'] and observation['channelId'] == send['channelId'] and observation['bodyHash'] == send['bodyHash'], 'DELIVERY_OBSERVATION_IDENTITY')
            require(receipt[0]['externalOperationId'] == send['opId'] and receipt[0]['payloadHash'] == send['bodyHash'] and receipt[0]['outcome'] == 'succeeded', 'DELIVERY_RECEIPT_IDENTITY')
            proof = receipt[0].get('verification', {})
            require(receipt[0].get('claim') == effect.get('currentClaim') and proof.get('verified') is True
                    and proof.get('installationGeneration') == effect['authorization']['installationGeneration']
                    and proof.get('serviceId') == receipt[0].get('serviceId') == 'shiyu-lab'
                    and proof.get('externalOperationId') == send['opId']
                    and proof.get('settledEffect') == {'idempotencyKey':send['opId'],'payloadHash':send['bodyHash'],'outcome':'succeeded'}
                    and type(proof.get('reconciled')) is bool and receipt[0].get('mode') in ('completion','reconciliation')
                    and (receipt[0]['mode'] != 'reconciliation' or proof['reconciled'] is True)
                    and 'lab-event:'+observation['eventId'] in receipt[0].get('evidenceRefs', []), 'DELIVERY_VERIFICATION')
            require(reservation['state'] == 'settled' and reservation['observed'] == {'tokens':0,'calls':0,'effects':1}, 'DELIVERY_USAGE')
        elif effect['status'] in ('dispatching','unknown'): check(reservation['state'] != 'settled', 'UNCERTAIN_EFFECT_RELEASED')
    delivered_event_ids = [send['observation']['eventId'] for send in sends.values() if send.get('observation')]
    require(len(delivered_event_ids) == len(set(delivered_event_ids)), 'DELIVERY_EVENT_REUSED')
    require(known == set(reservations), 'RESERVATION_COVERAGE')
    spent, held = dict.fromkeys(AXES,0), dict.fromkeys(AXES,0)
    for r in reservations.values():
        require(r['mandateId'] == c['mandateId'] and r['scope'] == 'local-owner' and r['state'] in ('reserved','unknown','settled'), 'RESERVATION_SCOPE')
        for axis in AXES:
            amount = integer(r['amount'][axis]); observed = r.get('observed',{}).get(axis)
            if observed is not None: integer(observed)
            if r['state'] == 'settled': require(observed is not None,'SETTLED_USAGE_MISSING'); spent[axis] += observed
            else: held[axis] += max(amount, observed or 0)
        if r['state'] == 'settled': require(any(receipt['result'] == r for receipt in data['budgetReceipts']), 'SETTLEMENT_RECEIPT_MISSING')
        check(not r.get('overrun'), 'BUDGET_OVERRUN')
    check(all(spent[a]+held[a] <= plan['budget'][a] for a in AXES), 'BUDGET_EXCEEDED')
    required = [{'sessionId':sid,'conversationId':cid} for sid,cid in sorted(required_sessions.items())]
    native, native_private = [], {}
    if mode == 'audit':
        supplied = [{'sessionId':s['sessionId'],'conversationId':s['conversationId']} for s in plan.get('sessions',[])]
        require(sorted(supplied,key=lambda x:x['sessionId']) == required, 'SESSION_ALLOWLIST_MISMATCH')
        for spec in plan.get('sessions',[]):
            paths = [Path(root)/spec['sessionId']/'session.v4.jsonl.zstd' for root in plan['paths']['sessionRoots']]
            present = [path for path in paths if path.exists()]; require(len(present) == 1, 'SESSION_FILE_MISSING_OR_AMBIGUOUS')
            raw, fingerprint = stable_read(present[0], plan['limits']['compressedSessionBytes']); header, events = decode_native(raw, plan['limits'])
            metadata = core.native_events(raw, plan['limits'], spec['cwd'])
            native_private[spec['sessionId']] = (events, metadata, spec['cwd'])
            native.append({'sessionId':spec['sessionId'],'conversationId':spec['conversationId'],'file':fingerprint,
                           'headerHash':metadata['headerHash'],'eventCounts':metadata['eventCounts'], 'events':metadata['events']})
    verified_replies = []; covered_assistants = set(); covered_turns = set()
    lifecycle = {sid:native_lifecycles(events) for sid,(events,_,_) in native_private.items()}
    for reply in replies.values():
        local = locals_by_reply.get(reply['replyId']); verified = False
        if mode == 'audit' and local and local.get('contextReceipt') and local.get('assistantRef'):
            context, assistant = local['contextReceipt'], local['assistantRef']; sid = context['sessionId']
            binding = local.get('nativeBinding', {})
            require(binding and all(context.get(key) == value for key,value in binding.items())
                    and binding.get('operationId') == local['operationId'] and binding.get('scope') == 'local-owner'
                    and binding.get('businessId') == local.get('businessId') and binding.get('sessionEpoch') == local.get('sessionEpoch'), 'NATIVE_BINDING_RECEIPT')
            require(sid == assistant['sessionId'] and sid in native_private and context.get('durability') == 'confirmed', 'NATIVE_REFERENCE_SCOPE')
            events, meta, cwd = native_private[sid]; first, last = context['userMessageSeq'], assistant['eventSeq']
            require(type(first) is int and type(last) is int and 0 <= first < last < len(events), 'NATIVE_REFERENCE_RANGE')
            user, answer = events[first], events[last]
            require(user['type'] == 'user/message' and user['data']['id'] == context['messageId'] and native_message_hash(user['data']) == context['messageHash'], 'NATIVE_INPUT_RECEIPT')
            require(answer['type'] == 'assistant/message' and not answer['data'].get('interrupted') and answer['data']['message']['id'] == assistant['messageId'], 'NATIVE_ASSISTANT_REFERENCE')
            verify_group(message_text(user['data']), local, reply['inputRefs'])
            text = message_text(answer['data']['message'], assistant=True); require(sha(text.encode()) == local.get('textSha256'), 'NATIVE_DRAFT_HASH')
            window = core.native_input_window(meta, {'inputRef':{'eventSeq':first}, 'assistantRef':{'eventSeq':last}}, cwd)
            require(window['nativeCwdContextVerified'], 'NATIVE_INPUT_WINDOW')
            r = reservations[reply['permit']['authorization']['reservationId']]
            if r['state'] == 'settled':
                require(r['observed']['tokens'] == answer['data'].get('usage',{}).get('totalTokens') and r['observed']['calls'] == 1 and r['observed']['effects'] == 0, 'NATIVE_USAGE_MISMATCH')
            turns = [turn for turn in lifecycle[sid]['rounds'] if turn['start'] < first < last < turn['end']]
            require(len(turns) == 1 and turns[0]['completed'] and len(turns[0]['steps']) == 1, 'NATIVE_TURN_INCOMPLETE')
            turn = turns[0]; step = turn['steps'][0]
            require(step['start'] < first < last < step.get('end',-1) and step['assistants'] == [last]
                    and answer['data'].get('turn') == turn['turn'] and answer['data'].get('step') == step['step'], 'NATIVE_STEP_IDENTITY')
            verified = r['state'] == 'settled'
            if verified:
                covered_assistants.add((sid,last,assistant['messageId'])); covered_turns.add((sid,turn['start']))
        verified_replies.append({'replyId':reply['replyId'],'nativeDraftVerified':verified})
    unlinked_native = 0
    for sid,(events,meta,cwd) in native_private.items():
        expected_inputs = {local['nativeBinding']['messageId'] for local in data['localReplies'] if local.get('nativeBinding',{}).get('sessionId') == sid}
        unlinked_native += len(lifecycle[sid]['issues']) + sum((sid,turn['start']) not in covered_turns for turn in lifecycle[sid]['rounds'])
        for event, public in zip(events,meta['events']):
            if event['type'] == 'assistant/message' and (sid,event['seq'],event.get('data',{}).get('message',{}).get('id')) not in covered_assistants: unlinked_native += 1
            elif event['type'] == 'user/message':
                message = event.get('data',{})
                if message.get('source',{}).get('kind') == 'runtime-context':
                    if public.get('runtimeContextValidBoundCwd') is not True: unlinked_native += 1
                elif message.get('id') not in expected_inputs: unlinked_native += 1
            elif event['type'] == 'assistant/attempt' or event['type'].startswith('compaction/') or event['type'] == 'session/title-llm-request': unlinked_native += 1
    native_coverage = mode == 'audit' and unlinked_native == 0
    evidence_metadata = None; observations = plan.get('deliveryObservations', [])
    if 'deliveryEvidence' in plan:
        raw, fingerprint = stable_read(plan['deliveryEvidence']['path'])
        require(fingerprint['sha256'] == plan['deliveryEvidence']['sha256'], 'DELIVERY_EVIDENCE_HASH')
        evidence = json.loads(raw)
        require(set(evidence) == {'schemaVersion','phase','runId','source','observations'} and evidence.get('schemaVersion') == 1 and evidence.get('phase') == '3H' and evidence.get('runId') == c['runId'], 'DELIVERY_EVIDENCE_SCOPE')
        source = evidence['source']; require(set(source) == {'kind','sha256','bytes'} and source['kind'] == 'lab-persisted-events', 'DELIVERY_EVIDENCE_SOURCE')
        identifier(source['sha256'], r'[a-f0-9]{64}'); integer(source['bytes'],1)
        observations = evidence['observations']; require(isinstance(observations,list) and len(observations) <= plan['limits']['sends'], 'DELIVERY_EVIDENCE_BOUND')
        for observed in observations:
            require(set(observed) == {'eventId','channelId','opId','bodyHash','observedAt'} and observed['opId'] in sends and observed['channelId'] in channels, 'DELIVERY_EVIDENCE_IDENTITY')
            identifier(observed['eventId']); identifier(observed['bodyHash'], r'[a-f0-9]{64}')
        require(len({o['opId'] for o in observations}) == len(observations) and len({o['eventId'] for o in observations}) == len(observations), 'DELIVERY_EVIDENCE_DUPLICATE')
        if 'deliveryObservations' in plan: require(plan['deliveryObservations'] == observations, 'DELIVERY_EVIDENCE_MISMATCH')
        evidence_metadata = {'file':fingerprint,'source':source,'level':'root-frozen-persisted-event-metadata'}
    deliveries_verified = bool(evidence_metadata and sends and all(any(all(o.get(k) == send.get('observation',{}).get(k) for k in ('opId','channelId','eventId','bodyHash')) for o in observations) for send in sends.values()))
    selected = {'connectionId':c['connectionId'],'runId':c['runId'],'status':c['status'],'epoch':c['epoch'],
                'replyIds':sorted(replies),'sendIds':sorted(sends),'inputIds':sorted(inputs),'ledgerSha256':sha(canonical(data).encode()),
                'budget':{'limits':plan['budget'],'spent':spent,'held':held}}
    no_replay = None
    if 'baseline' in plan:
        raw, fingerprint = stable_read(plan['baseline']['path']); require(fingerprint['sha256'] == plan['baseline']['sha256'], 'BASELINE_HASH')
        baseline = json.loads(raw); require(baseline.get('phase') == '3H' and baseline.get('selected',{}).get('connectionId') == c['connectionId'] and baseline['selected'].get('runId') == c['runId'], 'BASELINE_SCOPE')
        no_replay = all(baseline['selected'].get(key) == selected[key] for key in ('replyIds','sendIds','inputIds'))
        old_files = {v['sessionId']:v['file']['sha256'] for v in baseline.get('native',[])}
        no_replay = no_replay and old_files == {v['sessionId']:v['file']['sha256'] for v in native}
        check(no_replay, 'PAUSE_RELOAD_REPLAY_OR_NATIVE_CHANGE')
    complete = bool(mode == 'audit' and replies and sends and len(sends) == len(replies) and all(v['nativeDraftVerified'] for v in verified_replies)
                    and all(e['status'] == 'succeeded' for e in effects.values()) and all(r['state'] == 'settled' for r in reservations.values())
                    and 'expectedInputs' in plan and deliveries_verified and native_coverage and not issues)
    if expectation == 'complete': check(complete, 'COMPLETION_UNPROVEN')
    result = {'schemaVersion':1,'phase':'3H','checkedAt':core.stamp(),'mode':mode,'expectation':expectation,
              'status':'mismatch' if issues else 'inventory' if mode == 'inventory' else 'verified' if complete else 'consistent-incomplete',
              'completionVerified':complete,'nativeFilesRead':len(native),'requiredSessions':required,'issues':issues,'selected':selected,
              'control':{key:[record(v) for v in value] if isinstance(value,list) else record(value) for key,value in data.items()},
              'native':native,'checks':{'replies':verified_replies,'nativeMessageCoverageComplete':native_coverage,'unlinkedNativeMessageCount':unlinked_native,'nativeLifecycle':{sid:{'rounds':len(value['rounds']),'issueCodes':value['issues']} for sid,value in lifecycle.items()},'independentDeliveryObservationsVerified':deliveries_verified,'deliveryEvidence':evidence_metadata,'pauseReloadNoReplayVerified':no_replay},
              'evidenceLimits':['Single explicitly selected control connection; no unrelated Session scan.',
                 'External delivery evidence is an owner-frozen metadata extract from the exact run persisted events; its provenance is separate from control receipts.',
                 'Native hashes prove exact persisted messages; call completeness remains the trusted observed-primary instrumentation attestation.',
                 'Known primary token usage is not full provider billing, cache accounting, embedding usage or side-channel cost coverage.',
                 'Unknown holds are retained; missing receipts do not prove that no message was delivered.'],
              'tools':{'scriptSha256':sha(Path(__file__).read_bytes()),'helperSha256':sha(_HELPER_PATH.read_bytes())},
              'bodyIncluded':False,'credentialsIncluded':False,'claimTokensIncluded':False}
    return result

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('plan','run-id','connection-id','control-db','output'): parser.add_argument('--'+name, required=True)
    parser.add_argument('--session-root', action='append', required=True)
    parser.add_argument('--mode',choices=('inventory','audit'),default='audit'); parser.add_argument('--expect',choices=('observe','complete'),default='observe')
    args = parser.parse_args()
    try:
        raw, fingerprint = stable_read(args.plan); plan = json.loads(raw)
        require(args.run_id == plan.get('runId') and args.connection_id == plan.get('connectionId') and {'controlDb':args.control_db,'sessionRoots':args.session_root} == plan.get('paths'), 'CLI_PLAN_MISMATCH')
        result = collect(plan,args.mode,args.expect); result['planFile'] = fingerprint; core.exclusive_json(args.output,result)
        print(json.dumps({key:result[key] for key in ('status','completionVerified','nativeFilesRead','issues')})); return 1 if result['issues'] else 0
    except Exception as error:
        print(json.dumps({'status':'rejected','code':str(error) if isinstance(error,AuditError) else 'AUDIT_INPUT_OR_STORAGE_ERROR'}),file=sys.stderr); return 2

if __name__ == '__main__': sys.exit(main())
