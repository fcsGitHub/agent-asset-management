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
import re
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


class EntityHint(BaseModel):
    text: str
    label: str = "ENTITY"


class ExtractRequest(BaseModel):
    revision_ref: str            # 来源修订引用（团队/资产/修订）
    text: str
    entity_hints: List[EntityHint] = []


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
        "extractor_version": EXTRACTOR_VERSION,
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

    # semantica 冲突检测：同名实体的属性冲突（真实调用）
    detector = ConflictDetector()
    by_name: Dict[str, List[Dict[str, Any]]] = {}
    for c in req.candidates:
        by_name.setdefault(c.name, []).append(
            {"id": c.entity_id, "name": c.name, "properties": c.properties})
    conflicts: List[Dict[str, Any]] = []
    for name, group in by_name.items():
        if len(group) < 2:
            continue
        found = detector.detect_conflicts(group)
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
