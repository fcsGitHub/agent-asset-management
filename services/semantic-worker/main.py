# 语义 worker（设计 19 章）。
# 通过适配器使用真实 semantica（PyPI 0.6.8，MIT）：
# - 关系候选：semantica.semantic_extract.RelationExtractor（中文文本，实体提示驱动）
# - 冲突检测：semantica.conflicts.ConflictDetector（同名实体属性/单位冲突）
# - 来源：ProvenanceManager 记录每次提取的实体、活动与来源引用（PROV-O 风格）
#
# 适配器契约（本系统拟定，非上游现成 API）：
# extract_candidates(revision_ref, text, entity_hints)
#   -> candidate_entities, candidate_relations, evidence_anchors, warnings
# validate_candidates(candidates)
#   -> structural_errors, conflicts, unresolved_entities
#
# 候选仅是候选：不能更新正式依赖、通道头、审批结果或业务权限。
import json
import os
import re
import urllib.request
from typing import Any, Dict, List, Optional

from fastapi import FastAPI
from pydantic import BaseModel

from semantica import __version__ as SEMANTICA_VERSION
from semantica.conflicts import ConflictDetector
from semantica.provenance import ProvenanceManager
from semantica.semantic_extract import RelationExtractor
from semantica.semantic_extract.types import Entity

EXTRACTOR_VERSION = f"taw-semantic-worker/1 + semantica/{SEMANTICA_VERSION}"

app = FastAPI(title="TAW semantic worker")
_provenance = ProvenanceManager()

# 本系统关系词表到中文触发模式的映射（候选映射，人工确认后才成为正式关系）
RELATION_PATTERNS: List[Dict[str, Any]] = [
    {"type": "dependsOn", "patterns": [r"依赖于", r"依赖", r"depends on"]},
    {"type": "documentedBy", "patterns": [r"由\s*([^，。;,；\s]+)\s*描述", r"documented by", r"参见"]},
    {"type": "runsOn", "patterns": [r"运行于", r"runs on"]},
    {"type": "verifies", "patterns": [r"验证了", r"verifies"]},
    {"type": "derivedFrom", "patterns": [r"派生自", r"derived from"]},
]

UNIT_KEYS = {"positionUnit", "velocityUnit", "angleUnit", "timeScale", "frame"}

# LLM 增强（可选）：enhance_llm=true 时调用真实 DeepSeek（OpenAI 兼容协议，stdlib 无新依赖）。
# LLM 候选与规则候选合并；候选永远是 candidate，人工确认后才成为正式关系。
# key 从环境读取，绝不写入日志或返回体。
RELATION_VOCAB = [spec["type"] for spec in RELATION_PATTERNS] + ["related_to"]


def _llm_chat(messages: List[Dict[str, str]], timeout: float = 25.0) -> Dict[str, Any]:
    api_key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not api_key or api_key == "replace-me":
        raise RuntimeError("DEEPSEEK_API_KEY 未配置")
    base = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    model = os.environ.get("DEEPSEEK_MODEL", "deepseek-chat")
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "temperature": 0.1}).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    choice = (data.get("choices") or [{}])[0].get("message", {})
    return {"content": choice.get("content") or "", "tokens": data.get("usage", {}).get("total_tokens", 0)}


def _llm_relation_candidates(text: str) -> List[Dict[str, Any]]:
    """真实 LLM 候选关系：限定词表 + 端点必须原文出现（真实偏移定位）。
    输出不合规（越词表/端点不在原文/自指）的一律丢弃，不折衷。"""
    sys_prompt = (
        "你是关系候选抽取器。从文本中抽取实体间的候选关系，只输出 JSON 数组，不要解释。"
        f"relation type 只能取：{json.dumps(RELATION_VOCAB, ensure_ascii=False)}。"
        '每个元素形如 {"type":"dependsOn","source":"<原文中的实体词>","target":"<原文中的实体词>",'
        '"evidence":"<支撑该关系的原文片段>"}。'
        "没有候选关系时输出 []。"
    )
    out = _llm_chat([
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": text[:6000]},
    ])
    content = out["content"]
    start, end = content.find("["), content.rfind("]")
    if start < 0 or end <= start:
        raise ValueError("LLM 输出不含 JSON 数组")
    raw = json.loads(content[start:end + 1])
    anchors: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        rel_type = str(item.get("type", ""))
        src, tgt = str(item.get("source", "")).strip(), str(item.get("target", "")).strip()
        if rel_type not in RELATION_VOCAB or not src or not tgt or src == tgt:
            continue
        si = text.find(src)
        ti = text.find(tgt)
        if si < 0 or ti < 0:
            continue  # 端点必须真实出现在原文中（可定位证据，不采信模型编造的词）
        evidence = str(item.get("evidence", ""))[:200] or text[max(si - 10, 0):min(ti + len(tgt) + 10, len(text))]
        anchors.append({
            "type": rel_type,
            "source": {"text": src, "start": si, "end": si + len(src)},
            "target": {"text": tgt, "start": ti, "end": ti + len(tgt)},
            "confidence": 0.75,
            "evidence": {"segment": evidence, "matched_pattern": "llm/deepseek"},
            "llm_proposed": True,
            "status": "candidate",
        })
    return anchors


class EntityHint(BaseModel):
    text: str
    label: str = "ENTITY"


class ExtractRequest(BaseModel):
    revision_ref: str            # 来源修订引用（团队/资产/修订）
    text: str
    entity_hints: List[EntityHint] = []
    enhance_llm: bool = False    # true 时叠加真实 LLM 候选（仍为候选，需人工确认）


class ValidateCandidate(BaseModel):
    entity_id: str
    name: str
    properties: Dict[str, Any] = {}
    relation_type: Optional[str] = None
    target_name: Optional[str] = None


class ValidateRequest(BaseModel):
    candidates: List[ValidateCandidate]


def _find_entities(text: str, hints: List[EntityHint]) -> List[Entity]:
    """实体定位：以提示词表为主（真实偏移），无提示时回退大写词/引号词。
    semantica 0.6.8 不含 NER 模型；实体定位由提示驱动并保留页段定位。"""
    found: Dict[tuple, Entity] = {}
    for hint in hints:
        for m in re.finditer(re.escape(hint.text), text):
            key = (m.start(), m.end())
            if key not in found:
                found[key] = Entity(
                    text=hint.text, label=hint.label,
                    start_char=m.start(), end_char=m.end(), confidence=0.9,
                )
    # 回退：引号词与「」词
    for m in re.finditer(r"[“「\"]([^”」\"]{2,24})[”」\"]", text):
        key = (m.start(1), m.end(1))
        if key not in found:
            found[key] = Entity(
                text=m.group(1), label="ENTITY",
                start_char=m.start(1), end_char=m.end(1), confidence=0.6,
            )
    return [found[k] for k in sorted(found.keys())]


@app.get("/healthz")
def healthz():
    return {"ok": True, "extractor": EXTRACTOR_VERSION}


@app.post("/extract_candidates")
def extract_candidates(req: ExtractRequest):
    warnings: List[str] = []
    if not req.text.strip():
        return {"candidate_entities": [], "candidate_relations": [],
                "evidence_anchors": [], "warnings": ["空文本，无候选"]}

    entities = _find_entities(req.text, req.entity_hints)
    if not entities:
        warnings.append("未定位到实体：请提供 entity_hints（实体提示）以获得定位证据")

    # semantica 关系候选（真实调用）
    rx = RelationExtractor()
    raw_rels = []
    if len(entities) >= 2:
        try:
            raw_rels = rx.extract_relations(req.text, entities)
        except Exception as e:  # 上游失败不伪装成功
            warnings.append(f"RelationExtractor 失败: {e}")

    # 触发模式精化：把 co-occurrence related_to 映射到词表关系（带证据定位）
    candidate_relations = []
    for rel in raw_rels:
        seg = req.text[max(rel.subject.start_char - 6, 0): min(rel.object.end_char + 6, len(req.text))]
        rel_type = "related_to"
        matched = None
        for spec in RELATION_PATTERNS:
            for pat in spec["patterns"]:
                m = re.search(pat, seg)
                if m:
                    rel_type = spec["type"]
                    matched = m.group(0)
                    break
            if rel_type != "related_to":
                break
        candidate_relations.append({
            "type": rel_type,
            "source": {"text": rel.subject.text, "start": rel.subject.start_char, "end": rel.subject.end_char},
            "target": {"text": rel.object.text, "start": rel.object.start_char, "end": rel.object.end_char},
            "confidence": rel.confidence,
            "evidence": {"segment": seg, "matched_pattern": matched},
            "status": "candidate",   # 永远是候选；确认只能由人完成
        })

    # LLM 增强（可选）：与规则候选合并去重（键 = type+端点词）。任何失败如实降级为规则结果。
    extractor_version = EXTRACTOR_VERSION
    if req.enhance_llm:
        try:
            llm_rels = _llm_relation_candidates(req.text)
            seen = {(r["type"], r["source"]["text"], r["target"]["text"]) for r in candidate_relations}
            for cand in llm_rels:
                key = (cand["type"], cand["source"]["text"], cand["target"]["text"])
                if key not in seen:
                    candidate_relations.append(cand)
                    seen.add(key)
            extractor_version = f"{EXTRACTOR_VERSION}+llm/deepseek"
        except Exception as e:  # 上游失败不伪装成功
            warnings.append(f"LLM 增强失败，已降级为规则候选: {e}")

    evidence_anchors = [
        {"text": e.text, "label": e.label, "start": e.start_char, "end": e.end_char,
         "revision_ref": req.revision_ref}
        for e in entities
    ]

    # 来源记录（真实 provenance 存储；entity_id + source + 元数据）
    _provenance.track_entity(
        entity_id=req.revision_ref,
        source="revision_text",
        metadata={"length": len(req.text), "extractor": EXTRACTOR_VERSION},
    )

    return {
        "candidate_entities": evidence_anchors,
        "candidate_relations": candidate_relations,
        "evidence_anchors": evidence_anchors,
        "warnings": warnings,
        "extractor_version": extractor_version,
    }


@app.post("/validate_candidates")
def validate_candidates(req: ValidateRequest):
    structural_errors: List[str] = []
    # 结构校验：关系候选必须有目标；单位字段必须在受控词表内
    UNIT_VOCAB = {"positionUnit": ["m", "km", "AU"], "velocityUnit": ["m/s", "km/s"],
                  "timeScale": ["TAI", "UTC", "TT", "TDB", "GPST"],
                  "frame": ["ECI", "ECEF", "ICRF", "ITRF", "LVLH", "RTN"]}
    for c in req.candidates:
        if c.relation_type and not c.target_name:
            structural_errors.append(f"{c.entity_id}: 关系候选缺少目标")
        for k, vocab in UNIT_VOCAB.items():
            v = c.properties.get(k)
            if v is not None and v not in vocab:
                structural_errors.append(f"{c.entity_id}: {k}=\"{v}\" 不在受控词表内")

    # semantica 冲突检测：同名实体的属性冲突（真实调用）。
    # semantica 的冲突检测按实体 id 分组（语义：同一实体来自不同来源）；
    # 候选场景中"同名"即候选同一现实实体 → 以名字作为分组键送检。
    # 仅检测、不合并：候选独立性由 unresolved_entities 与人工消歧保证。
    detector = ConflictDetector()
    by_name: Dict[str, List[Dict[str, Any]]] = {}
    for c in req.candidates:
        by_name.setdefault(c.name, []).append(
            {"id": c.entity_id, "name": c.name, "properties": c.properties})
    conflicts: List[Dict[str, Any]] = []
    for name, group in by_name.items():
        if len(group) < 2:
            continue
        renamed = [{"id": name, "name": name, "properties": g["properties"]} for g in group]
        found = detector.detect_conflicts(renamed)
        for cf in found:
            conflicts.append({
                "name": name,
                "type": str(getattr(cf, "conflict_type", "unknown")),
                "property": str(getattr(cf, "property_name", "") or ""),
                "description": str(getattr(cf, "description", ""))[:300],
            })

    # 同名未消歧：同名且没有冲突证据支撑合并 → unresolved（人工消歧，不自动合并）
    unresolved_entities = [name for name, group in by_name.items()
                           if len(group) > 1
                           and not any(cf["name"] == name for cf in conflicts)]
    return {
        "structural_errors": structural_errors,
        "conflicts": conflicts,
        "unresolved_entities": unresolved_entities,
        "extractor_version": EXTRACTOR_VERSION,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=int(__import__("os").environ.get("SEMANTIC_WORKER_PORT", "8100")))
