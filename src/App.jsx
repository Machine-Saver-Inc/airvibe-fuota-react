import React, { useEffect, useMemo, useRef, useState } from "react";

const COL = {
  green: "#00bf63",
  red: "#ff5050",
  grey: "#b4b4b4",
  yellow: "#ffd21f",
  axis1: "#00357a",
  axis2: "#1f80ff",
  axis3: "#c2dcff",
};

function hexToBytes(hex) {
  const clean = hex.replace(/\s|0x/gi, "").toLowerCase();
  if (!/^[0-9a-f]*$/.test(clean)) throw new Error("Hex contains invalid characters");
  if (clean.length % 2 !== 0) throw new Error("Hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  return out;
}

function i16From(bytes, start, count) {
  const arr = [];
  for (let i = 0; i < count; i++) {
    const off = start + i * 2;
    const v = (bytes[off] << 8) | bytes[off + 1];
    arr.push(v & 0x8000 ? v - 0x10000 : v);
  }
  return arr;
}

function axisMaskToText(mask) {
  const axes = [];
  if (mask & 0x1) axes.push("Axis 1");
  if (mask & 0x2) axes.push("Axis 2");
  if (mask & 0x4) axes.push("Axis 3");
  return axes.length ? axes.join(", ") : "None";
}

function filterCodeToText(code) {
  if (code === 0x81) return "Low-pass 2670 Hz";
  return `Code 0x${code.toString(16)}`;
}

function decodePacket(hex) {
  const b = hexToBytes(hex);
  const type = b[0];
  const txId = b[1];
  const seg = (b[2] << 8) | b[3];

  if (type === 0x03) {
    const axisSel = b[4];
    const errorCode = b[5];
    const numSegments = b[6];
    const hwFilterCode = b[7];
    const sr = (b[8] << 8) | b[9];
    const nSamplesEachAxis = (b[10] << 8) | b[11];
    return {
      PacketType: 3,
      TransactionID: txId,
      SegmentNumber: seg,
      ErrorCode: errorCode,
      AxisSelection: axisSel,
      AxisSelectionText: axisMaskToText(axisSel),
      NumberOfSegments: numSegments,
      HardwareFilterCode: hwFilterCode,
      HardwareFilterText: filterCodeToText(hwFilterCode),
      SamplingRate_Hz: sr,
      NumberOfSamplesEachAxis: nSamplesEachAxis,
      LastSegment: false,
      _raw: b,
    };
  }

  if (type === 0x01 || type === 0x05) {
    const sampleBytes = b.slice(4);
    if (sampleBytes.length % 2 !== 0) throw new Error("Sample payload length must be even");
    const n = sampleBytes.length / 2;
    const Samples_i16 = i16From(sampleBytes, 0, n);
    const triplets = [];
    for (let i = 0; i < Samples_i16.length; i += 3) {
      if (i + 2 < Samples_i16.length) triplets.push([Samples_i16[i], Samples_i16[i + 1], Samples_i16[i + 2]]);
    }
    return {
      PacketType: type,
      TransactionID: txId,
      SegmentNumber: seg,
      LastSegment: type === 0x05,
      Samples_i16,
      Samples_Triplets_i16: triplets,
      _raw: b,
    };
  }

  throw new Error(`Unsupported PacketType 0x${type.toString(16)}`);
}

function variance(arr) {
  if (!arr || arr.length === 0) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  let v = 0;
  for (const x of arr) {
    const d = x - mean;
    v += d * d;
  }
  return v / arr.length;
}

function inferAxisMaskFromData(pkt) {
  const trip = pkt.Samples_Triplets_i16 || [];
  const triVar = trip.length
    ? [
        variance(trip.map((t) => t?.[0] ?? 0)),
        variance(trip.map((t) => t?.[1] ?? 0)),
        variance(trip.map((t) => t?.[2] ?? 0)),
      ]
    : [0, 0, 0];
  const triActive = triVar.filter((v) => v > 0).length;
  if (triActive >= 2)
    return { mask: 0x07, reason: "AxisSelection=0; inferred tri-axial from triplet variance." };
  const flat = pkt.Samples_i16 || [];
  const v1 = variance(flat);
  const order = [0x02, 0x01, 0x04];
  const chosen = v1 > 0 ? order[0] : order[1];
  return { mask: chosen, reason: "AxisSelection=0; inferred single-axis and preferred Axis 2 by policy." };
}

function initSegSizes(tx) {
  const isTri = tx.axisMask === 0x07;
  const cap = isTri ? 7 : 21;
  const sizes = new Array(tx.expected).fill(cap);
  if (tx.samplesPerAxis != null) {
    const rem = tx.samplesPerAxis % cap;
    if (rem !== 0) sizes[sizes.length - 1] = rem;
  }
  tx.segSizes = sizes;
}

function buildMissingHex(idxs) {
  const s = idxs.map((x) => x.toString(16).padStart(2, "0")).join("");
  return `02${s}`;
}

function assemble(prev, pkt) {
  const tx = prev[pkt.TransactionID] ?? {
    txId: pkt.TransactionID,
    params: null,
    expected: null,
    segments: new Map(),
    axisMask: 0,
    sr: null,
    samplesPerAxis: null,
    segSizes: null,
    sawDataBeforeParams: false,
    requestedMissing: false,
    downlinks: [],
    warnings: [],
    saw05: false,
  };

  if (pkt.PacketType === 3) {
    tx.params = pkt;
    tx.expected = pkt.NumberOfSegments;
    tx.axisMask = pkt.AxisSelection;
    tx.sr = pkt.SamplingRate_Hz;
    tx.samplesPerAxis = pkt.NumberOfSamplesEachAxis;

    if ([0x07, 0x01, 0x02, 0x04].includes(tx.axisMask)) initSegSizes(tx);

    tx.downlinks = [
      { label: "ACK TWIU", port: 20, hex: `03${pkt.TransactionID.toString(16).padStart(2, "0")}` },
    ];
  } else {
    if (!tx.params) {
      tx.sawDataBeforeParams = true;
      tx.downlinks = [{ label: "REQ Current TWIU", port: 22, hex: "0001" }];
    }

    if (![0x07, 0x01, 0x02, 0x04].includes(tx.axisMask)) {
      const inf = inferAxisMaskFromData(pkt);
      tx.axisMask = inf.mask;
      if (inf.reason) tx.warnings.push(inf.reason);
      if (!tx.segSizes && tx.samplesPerAxis != null) initSegSizes(tx);
    }

    const validSingle = (m) => m === 0x01 || m === 0x02 || m === 0x04;
    if (tx.axisMask !== 0x07 && !validSingle(tx.axisMask)) {
      tx.warnings.push(
        `Invalid AxisSelection 0x${(tx.axisMask || 0).toString(16)} — sensor should be tri (0x07) or single (0x01/0x02/0x04).`
      );
    }

    tx.segments.set(pkt.SegmentNumber, pkt);
    if (pkt.PacketType === 0x05) tx.saw05 = true;
  }

  const missing = [];
  let maxSeen = -1;
  if (tx.expected != null) {
    for (let i = 0; i < tx.expected; i++) if (tx.segments.has(i)) maxSeen = Math.max(maxSeen, i);
    for (let i = 0; i < tx.expected; i++) if (!tx.segments.has(i)) missing.push(i);
  }
  const complete = tx.expected != null && missing.length === 0 && tx.segments.size === tx.expected;

  if (pkt.PacketType === 0x05) {
    if (missing.length > 0) {
      tx.requestedMissing = true;
      tx.downlinks = [
        ...(tx.downlinks || []),
        { label: `Request Missing Segments [${missing.join(", ")}]`, port: 22, hex: buildMissingHex(missing) },
      ];
    } else {
      tx.downlinks = [
        ...(tx.downlinks || []),
        { label: "Download assembled CSV", port: 0, hex: `export:${tx.txId}` },
        { label: "ACK ALL", port: 20, hex: `01${tx.txId.toString(16).padStart(2, "0")}` },
      ];
    }
  }

  return { ...prev, [tx.txId]: { ...tx, missing, maxSeen, complete } };
}

function segmentStates(tx) {
  if (!tx.expected) return [];
  const out = new Array(tx.expected).fill("grey");
  const have = new Set([...tx.segments.keys()]);
  const maxSeen = tx.maxSeen ?? -1;
  for (let i = 0; i <= maxSeen; i++) out[i] = have.has(i) ? "green" : "red";
  for (let i = maxSeen + 1; i < tx.expected; i++) out[i] = "grey";
  if (tx.requestedMissing) for (const i of tx.missing || []) if (!have.has(i)) out[i] = "yellow";
  return out;
}

function buildWaveformForPlot(tx) {
  if (!tx.expected || !tx.sr || !tx.samplesPerAxis) return null;
  const states = segmentStates(tx);
  const isTri = tx.axisMask === 0x07;
  const axis = [[], [], []];
  const segRects = [];
  let sampleIndex = 0;
  for (let s = 0; s < tx.expected; s++) {
    const pkt = tx.segments.get(s);
    const state = states[s];
    const color =
      state === "green"
        ? COL.green
        : state === "red"
        ? COL.red
        : state === "yellow"
        ? COL.yellow
        : COL.grey;
    let segLen;
    if (pkt) segLen = isTri ? pkt.Samples_Triplets_i16?.length || 0 : pkt.Samples_i16?.length || 0;
    else segLen = tx.segSizes?.[s] ?? (isTri ? 7 : 21);
    segRects.push({ i0: sampleIndex, i1: sampleIndex + segLen, color });
    for (let k = 0; k < segLen; k++) {
      if (state === "green" && pkt) {
        if (isTri) {
          const t = pkt.Samples_Triplets_i16?.[k];
          axis[0].push(t?.[0] ?? 0);
          axis[1].push(t?.[1] ?? 0);
          axis[2].push(t?.[2] ?? 0);
        } else {
          const v = pkt.Samples_i16?.[k] ?? 0;
          const sel = tx.axisMask & 0x07;
          axis[0].push(sel === 0x01 ? v : 0);
          axis[1].push(sel === 0x02 ? v : 0);
          axis[2].push(sel === 0x04 ? v : 0);
        }
      } else {
        axis[0].push(0);
        axis[1].push(0);
        axis[2].push(0);
      }
      sampleIndex++;
    }
  }
  return { axis, segRects, totalSamples: sampleIndex };
}

function buildCsvForTx(tx) {
  const wf = buildWaveformForPlot(tx);
  if (!wf) throw new Error("Waveform not ready to export");
  const meta = [
    `# tx_id=${tx.txId}`,
    `axis_selection=${tx.params ? tx.params.AxisSelectionText : axisMaskToText(tx.axisMask)}`,
    `sampling_rate_hz=${tx.sr}`,
    `filter=${tx.params ? tx.params.HardwareFilterText : ""}`,
    `segments=${tx.expected}`,
    `samples_per_axis=${tx.samplesPerAxis}`,
    `total_samples=${wf.totalSamples}`,
  ].join(", ");
  const header = "sample_index,axis1,axis2,axis3";
  const rows = [];
  for (let i = 0; i < wf.totalSamples; i++)
    rows.push(`${i},${wf.axis[0][i] ?? 0},${wf.axis[1][i] ?? 0},${wf.axis[2][i] ?? 0}`);
  return `${meta}\n${header}\n${rows.join("\n")}`;
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function useResize(elRef) {
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!elRef.current) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) setW(Math.max(300, e.contentRect.width));
    });
    ro.observe(elRef.current);
    return () => ro.disconnect();
  }, [elRef]);
  return w;
}

function SvgWave({ tx }) {
  const hostRef = useRef(null);
  const width = useResize(hostRef);
  const height = 360;
  const pad = { l: 50, r: 16, t: 12, b: 28 };
  const wf = useMemo(() => buildWaveformForPlot(tx), [tx]);
  const contentW = Math.max(10, width - pad.l - pad.r);
  const contentH = Math.max(10, height - pad.t - pad.b);
  if (!wf) return <div ref={hostRef} style={{ height }} />;
  const N = wf.totalSamples || 1;
  const xs = (i) => pad.l + ((i / (N - 1 || 1)) * contentW);
  const isTri = tx.axisMask === 0x07;
  const activeAxes = isTri
    ? [0, 1, 2]
    : tx.axisMask & 0x01
    ? [0]
    : tx.axisMask & 0x02
    ? [1]
    : tx.axisMask & 0x04
    ? [2]
    : [0];
  const allY = activeAxes.flatMap((ai) => wf.axis[ai]);
  let ymin = Math.min(...allY, 0);
  let ymax = Math.max(...allY, 0);
  if (ymin === ymax) {
    ymin = -1;
    ymax = 1;
  }
  const ys = (v) => pad.t + (1 - (v - ymin) / (ymax - ymin)) * contentH;
  const poly = (arr) => arr.map((y, i) => `${xs(i)},${ys(y)}`).join(" ");
  const clipId = `clip-${tx.txId}`;
  const axisColors = [COL.axis1, COL.axis2, COL.axis3];
  const axisLabels = ["Axis 1", "Axis 2", "Axis 3"];
  return (
    <div ref={hostRef} className="w-full">
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={pad.l} y={pad.t} width={contentW} height={contentH} />
          </clipPath>
        </defs>
        <rect x={pad.l} y={pad.t} width={contentW} height={contentH} fill="#0b1730" stroke="#1f2937" />
        <g clipPath={`url(#${clipId})`}>
          {wf.segRects.map((r, i) => (
            <rect
              key={i}
              x={xs(r.i0)}
              y={pad.t}
              width={xs(r.i1) - xs(r.i0)}
              height={contentH}
              fill={r.color}
              opacity="0.22"
            />
          ))}
        </g>
        {activeAxes.map((ai) => (
          <polyline key={ai} fill="none" stroke={axisColors[ai]} strokeWidth="2" points={poly(wf.axis[ai])} />
        ))}
        {[ymin, 0, ymax].map((v, i) => (
          <g key={i}>
            <line x1={pad.l} x2={pad.l + contentW} y1={ys(v)} y2={ys(v)} stroke="#334155" strokeDasharray="3 4" />
            <text x={pad.l - 6} y={ys(v) + 4} fontSize="10" textAnchor="end" fill="#94a3b8">
              {v}
            </text>
          </g>
        ))}
        {activeAxes.map((ai, i) => (
          <g key={ai} transform={`translate(${pad.l + i * 90}, ${height - pad.b + 16})`}>
            <rect x={0} y={-10} width={18} height={3} fill={axisColors[ai]} />
            <text x={24} y={-6} fontSize="11" fill="#cbd5e1">
              {axisLabels[ai]}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}

function SegmentsGrid({ tx }) {
  const states = segmentStates(tx);
  return (
    <div className="grid grid-cols-12 gap-2">
      {states.map((st, i) => (
        <div
          key={i}
          className="relative flex items-center justify-center w-10 h-10 rounded-full text-[12px] font-mono"
          style={{ background: "#0b1730", color: "#e5e7eb", outline: `3px solid ${COL[st]}`, outlineOffset: "3px" }}
        >
          {i}
        </div>
      ))}
    </div>
  );
}

const Sep = () => <span aria-hidden="true"> {"\u2014"} </span>;
const sanitize = (s) => String(s).replace(/[<>]/g, (m) => (m === "<" ? "‹" : "›"));

function CodeHex({ bytes }) {
  if (!bytes) return null;
  const s = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return <code className="text-xs break-words whitespace-pre-wrap">{s}</code>;
}

function runSelfTests() {
  const items = [];
  const pass = (name, info = "") => items.push({ name, ok: true, info });
  const fail = (name, info = "") => items.push({ name, ok: false, info });

  try {
    const b = hexToBytes("00");
    b.length === 1 && b[0] === 0 ? pass("hexToBytes basic") : fail("hexToBytes basic");
  } catch (e) {
    fail("hexToBytes basic", e.message);
  }
  try {
    hexToBytes("0");
    fail("hexToBytes odd length should throw");
  } catch (e) {
    pass("hexToBytes odd length should throw");
  }
  try {
    hexToBytes("zz");
    fail("hexToBytes invalid char should throw");
  } catch (e) {
    pass("hexToBytes invalid char should throw");
  }

  try {
    const p = decodePacket("03210000070003814e200015");
    p.PacketType === 3 &&
    p.TransactionID === 0x21 &&
    p.NumberOfSegments === 3 &&
    p.NumberOfSamplesEachAxis === 0x0015 &&
    p.AxisSelection === 0x07
      ? pass("decodePacket Type03 fields (tri)")
      : fail("decodePacket Type03 fields (tri)", JSON.stringify(p));
  } catch (e) {
    fail("decodePacket Type03 fields (tri)", e.message);
  }

  try {
    const p = decodePacket("032a0000020004814e200053");
    p.PacketType === 3 &&
    p.TransactionID === 0x2a &&
    p.AxisSelection === 0x02 &&
    p.NumberOfSegments === 4 &&
    p.SamplingRate_Hz === 20000 &&
    p.NumberOfSamplesEachAxis === 0x0053
      ? pass("decodePacket Type03 fields (single axis 2)")
      : fail("decodePacket Type03 fields (single axis 2)", JSON.stringify(p));
  } catch (e) {
    fail("decodePacket Type03 fields (single axis 2)", e.message);
  }

  try {
    const p = decodePacket(
      "01210001fffd0005fff8fffc0003fffa00000004fffc0000000500000003000200020006ffff00030005ffff0000"
    );
    p.PacketType === 1 && p.SegmentNumber === 1 && Array.isArray(p.Samples_Triplets_i16) && p.Samples_Triplets_i16.length === 7
      ? pass("decodePacket Type01 triplets length")
      : fail("decodePacket Type01 triplets length");
  } catch (e) {
    fail("decodePacket Type01", e.message);
  }

  try {
    let st = {};
    const d1 = decodePacket(
      "01210000ffff000000020000fffc00020000fffd0003fffffffc0001fffdfffefffeffff0002ffff00000005fffb"
    );
    st = assemble(st, d1);
    const tx = st[d1.TransactionID];
    tx.sawDataBeforeParams && tx.downlinks[0]?.port === 22
      ? pass("assemble recommends REQ TWIU when data arrives first")
      : fail("assemble recommends REQ TWIU when data arrives first");
  } catch (e) {
    fail("assemble data-before-params", e.message);
  }

  try {
    let st = {};
    const p03 = decodePacket("03210000070003814e200015");
    st = assemble(st, p03);
    const p01seg1 = decodePacket(
      "01210001fffd0005fff8fffc0003fffa00000004fffc0000000500000003000200020006ffff00030005ffff0000"
    );
    st = assemble(st, p01seg1);
    const tx = st[p03.TransactionID];
    const states = segmentStates(tx);
    states[0] === "red" && states[1] === "green" && states[2] === "grey"
      ? pass("segmentStates red/green/grey before 05")
      : fail("segmentStates red/green/grey before 05", JSON.stringify(states));
  } catch (e) {
    fail("segmentStates test", e.message);
  }

  try {
    let st = {};
    const p03 = decodePacket("03210000070003814e200015");
    st = assemble(st, p03);
    const seg1 = decodePacket(
      "01210001fffd0005fff8fffc0003fffa00000004fffc0000000500000003000200020006ffff00030005ffff0000"
    );
    st = assemble(st, seg1);
    const wf = buildWaveformForPlot(st[p03.TransactionID]);
    const colors = wf.segRects.map((r) => r.color);
    colors[0] === COL.red && colors[1] === COL.green && colors[2] === COL.grey
      ? pass("waveform shading matches segment states (red/green/grey)")
      : fail("waveform shading state mismatch", JSON.stringify(colors));
  } catch (e) {
    fail("buildWaveformForPlot shading", e.message);
  }

  try {
    let st = {};
    const p03 = decodePacket("03210000070003814e200015");
    st = assemble(st, p03);
    const seg1 = decodePacket(
      "01210001fffd0005fff8fffc0003fffa00000004fffc0000000500000003000200020006ffff00030005ffff0000"
    );
    st = assemble(st, seg1);
    const seg2_last = decodePacket(
      "052100020002fffe00000003fffffffd0003fffdfffcfffffffc0003ffff00000005000000020004000200000007"
    );
    st = assemble(st, seg2_last);
    const states = segmentStates(st[p03.TransactionID]);
    states[0] === "yellow"
      ? pass("missing segment turns yellow after 05")
      : fail("missing segment should be yellow after 05", JSON.stringify(states));
  } catch (e) {
    fail("post-05 yellow state", e.message);
  }

  try {
    let st = {};
    const p03 = decodePacket("03210000070003814e200015");
    st = assemble(st, p03);
    const seg1 = decodePacket(
      "01210001fffd0005fff8fffc0003fffa00000004fffc0000000500000003000200020006ffff00030005ffff0000"
    );
    st = assemble(st, seg1);
    const wf = buildWaveformForPlot(st[p03.TransactionID]);
    const r0 = wf.segRects[0];
    const r1 = wf.segRects[1];
    const r2 = wf.segRects[2];
    const anyNonZero = (arr, a, b) => arr.slice(a, b).some((v) => v !== 0);
    const allZero = (arr, a, b) => arr.slice(a, b).every((v) => v === 0);
    const nz1 =
      anyNonZero(wf.axis[0], r1.i0, r1.i1) ||
      anyNonZero(wf.axis[1], r1.i0, r1.i1) ||
      anyNonZero(wf.axis[2], r1.i0, r1.i1);
    const z0 =
      allZero(wf.axis[0], r0.i0, r0.i1) &&
      allZero(wf.axis[1], r0.i0, r0.i1) &&
      allZero(wf.axis[2], r0.i0, r0.i1);
    const z2 =
      allZero(wf.axis[0], r2.i0, r2.i1) &&
      allZero(wf.axis[1], r2.i0, r2.i1) &&
      allZero(wf.axis[2], r2.i0, r2.i1);
    nz1 && z0 && z2
      ? pass("zero-fill works for non-green segments")
      : fail("zero-fill failure");
  } catch (e) {
    fail("zero-fill test", e.message);
  }

  try {
    let st = {};
    const p03 = decodePacket("03210000070003814e200015");
    st = assemble(st, p03);
    const sizes = st[p03.TransactionID].segSizes;
    Array.isArray(sizes) && sizes.join(",") === "7,7,7"
      ? pass("tri-axial segSizes 7/7/7")
      : fail("tri-axial segSizes wrong", JSON.stringify(sizes));
  } catch (e) {
    fail("tri-axial segSizes test", e.message);
  }

  try {
    let st = {};
    const p03 = decodePacket("03300000000102814e200022");
    st = assemble(st, p03);
    const sizes = st[p03.TransactionID].segSizes;
    Array.isArray(sizes) && sizes.length === 2 && sizes[0] === 21 && sizes[1] === 13
      ? pass("single-axis segSizes 21/13")
      : fail("single-axis segSizes wrong", JSON.stringify(sizes));
  } catch (e) {
    fail("single-axis segSizes test", e.message);
  }

  try {
    const t = filterCodeToText(0x81);
    t === "Low-pass 2670 Hz" ? pass("filterCodeToText maps 0x81") : fail("filterCodeToText wrong", t);
  } catch (e) {
    fail("filterCodeToText", e.message);
  }

  try {
    let st = {};
    const p03 = decodePacket("03210000070003814e200015");
    st = assemble(st, p03);
    const seg0 = decodePacket(
      "01210000ffff000000020000fffc00020000fffd0003fffffffc0001fffdfffefffeffff0002ffff00000005fffb"
    );
    const seg1 = decodePacket(
      "01210001fffd0005fff8fffc0003fffa00000004fffc0000000500000003000200020006ffff00030005ffff0000"
    );
    const seg2 = decodePacket(
      "052100020002fffe00000003fffffffd0003fffdfffcfffffffc0003ffff00000005000000020004000200000007"
    );
    st = assemble(st, seg0);
    st = assemble(st, seg1);
    st = assemble(st, seg2);
    const tx = st[p03.TransactionID];
    const csv = buildCsvForTx(tx);
    const lines = csv.split(/\n/);
    const headerOk = lines[1] === "sample_index,axis1,axis2,axis3";
    const metaOk = /^# tx_id=/.test(lines[0]);
    const wf = buildWaveformForPlot(tx);
    const rowsOk = lines.length === wf.totalSamples + 2;
    headerOk && metaOk && rowsOk
      ? pass("CSV export format")
      : fail("CSV export format", JSON.stringify({ headerOk, metaOk, rows: lines.length }));
  } catch (e) {
    fail("CSV export", e.message);
  }

  try {
    let st = {};
    const t03 = decodePacket("032a0000020002814e20001c");
    st = assemble(st, t03);
    const d0 = decodePacket(
      "012a000000000003000300030001000500080002fffdfffdfffcfffbfffffffffffd00000001ffff0001fffffffd"
    );
    const d1 = decodePacket("052a0001fffffffcfffbffff0001000400040000");
    st = assemble(st, d0);
    st = assemble(st, d1);
    const tx = st[t03.TransactionID];
    const wf = buildWaveformForPlot(tx);
    const sizesOk = Array.isArray(tx.segSizes) && tx.segSizes.length === 2 && tx.segSizes[0] === 21 && tx.segSizes[1] === 7;
    const samplesOk = wf.totalSamples === 28;
    const onlyAxis2 = wf.axis[1].some((v) => v !== 0) && wf.axis[0].every((v) => v === 0) && wf.axis[2].every((v) => v === 0);
    sizesOk && samplesOk && onlyAxis2
      ? pass("partial final segment; Axis 2 only; 21/7 sizing")
      : fail("partial final segment check", JSON.stringify({ sizes: tx.segSizes, total: wf.totalSamples }));
  } catch (e) {
    fail("partial final segment test", e.message);
  }

  try {
    let st = {};
    const t03 = decodePacket("032c0000010004814e200053");
    st = assemble(st, t03);
    const a0 = decodePacket(
      "012c0000ffff0000fffdfffafffb0002000600040002fffffffdffff0001000000020004000200030000fffdfffd"
    );
    const a1 = decodePacket(
      "012c0001fffdfffcfffbfffdfffdfffbfffbfffbfffd000100030004000400000001000200040004000200030007"
    );
    const a2 = decodePacket(
      "012c0002000000000000fffdffff0000000400040000fffffffdfffdfffffffe0000000500040000fffdfffefffa"
    );
    const a3 = decodePacket(
      "052c0003fffbfffe0001000500030000fffffffefffe000200040006000400020000000300080000fffe00000000"
    );
    st = assemble(st, a0);
    st = assemble(st, a1);
    st = assemble(st, a2);
    st = assemble(st, a3);
    const wf = buildWaveformForPlot(st[t03.TransactionID]);
    const onlyA1 = wf.axis[0].some((v) => v !== 0) && wf.axis[1].every((v) => v === 0) && wf.axis[2].every((v) => v === 0);
    onlyA1
      ? pass("single-axis Axis 1 renders only one active trace")
      : fail("single-axis Axis 1 trace check");
  } catch (e) {
    fail("single-axis Axis 1 test", e.message);
  }

  try {
    let st = {};
    const t03 = decodePacket("032b0000040004814e200053");
    st = assemble(st, t03);
    const a0 = decodePacket(
      "012b0000ffff0000fffdfffafffb0002000600040002fffffffdffff0001000000020004000200030000fffdfffd"
    );
    const a1 = decodePacket(
      "012b0001fffdfffcfffbfffdfffdfffbfffbfffbfffd000100030004000400000001000200040004000200030007"
    );
    const a2 = decodePacket(
      "012b0002000000000000fffdffff0000000400040000fffffffdfffdfffffffe0000000500040000fffdfffefffa"
    );
    const a3 = decodePacket(
      "052b0003fffbfffe0001000500030000fffffffefffe000200040006000400020000000300080000fffe00000000"
    );
    st = assemble(st, a0);
    st = assemble(st, a1);
    st = assemble(st, a2);
    st = assemble(st, a3);
    const wf = buildWaveformForPlot(st[t03.TransactionID]);
    const onlyA3 = wf.axis[2].some((v) => v !== 0) && wf.axis[0].every((v) => v === 0) && wf.axis[1].every((v) => v === 0);
    onlyA3
      ? pass("single-axis Axis 3 renders only one active trace")
      : fail("single-axis Axis 3 trace check");
  } catch (e) {
    fail("single-axis Axis 3 test", e.message);
  }

  try {
    let st = {};
    const t03 = decodePacket("032a0000020004814e200053");
    st = assemble(st, t03);
    const d0 = decodePacket(
      "012a0000ffff0000fffdfffafffb0002000600040002fffffffdffff0001000000020004000200030000fffdfffd"
    );
    const d1 = decodePacket(
      "012a0001fffdfffcfffbfffdfffdfffbfffbfffbfffd000100030004000400000001000200040004000200030007"
    );
    const d2 = decodePacket(
      "012a0002000000000000fffdffff0000000400040000fffffffdfffdfffffffe0000000500040000fffdfffefffa"
    );
    const d3 = decodePacket(
      "052a0003fffbfffe0001000500030000fffffffefffe000200040006000400020000000300080000fffe00000000"
    );
    st = assemble(st, d0);
    st = assemble(st, d1);
    st = assemble(st, d2);
    st = assemble(st, d3);
    const wf = buildWaveformForPlot(st[t03.TransactionID]);
    const any2 = wf.axis[1].some((v) => v !== 0);
    const all1Zero = wf.axis[0].every((v) => v === 0);
    const all3Zero = wf.axis[2].every((v) => v === 0);
    any2 && all1Zero && all3Zero
      ? pass("single-axis Axis 2 renders only one active trace (83)")
      : fail("single-axis Axis 2 trace check (83)", JSON.stringify({ any2, all1Zero, all3Zero }));
  } catch (e) {
    fail("single-axis Axis 2 test (83)", e.message);
  }

  const passed = items.filter((i) => i.ok).length;
  const failed = items.length - passed;
  return { passed, failed, items };
}

export default function App() {
  const [hexInput, setHexInput] = useState("");
  const [log, setLog] = useState([]);
  const [waves, setWaves] = useState({});
  const [error, setError] = useState(null);
  const [tests, setTests] = useState({ passed: 0, failed: 0, items: [] });

  useEffect(() => {
    const res = runSelfTests();
    setTests(res);
  }, []);

  const onIngest = () => {
    setError(null);
    try {
      const lines = hexInput.split(/\n+/).map((s) => s.trim()).filter(Boolean);
      const newPkts = lines.map(decodePacket);
      const newLog = [...log, ...newPkts];
      let state = { ...waves };
      for (const p of newPkts) state = assemble(state, p);
      setLog(newLog);
      setWaves(state);
    } catch (e) {
      setError(e.message);
    }
  };

  const fillExample = () => {
    const example = [
      "03210000070003814e200015",
      "01210000ffff000000020000fffc00020000fffd0003fffffffc0001fffdfffefffeffff0002ffff00000005fffb",
      "01210001fffd0005fff8fffc0003fffa00000004fffc0000000500000003000200020006ffff00030005ffff0000",
      "052100020002fffe00000003fffffffd0003fffdfffcfffffffc0003ffff00000005000000020004000200000007",
    ].join("\n");
    setHexInput(example);
  };

  const activeTxIds = useMemo(() => Object.keys(waves).map((k) => parseInt(k, 10)).sort((a, b) => a - b), [waves]);

  const handleDownload = (tx) => {
    try {
      const csv = buildCsvForTx(tx);
      downloadText(`airvibe_tx_${tx.txId}_${Date.now()}.csv`, csv);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 p-6">
      <div className="max-w-6xl mx-auto grid gap-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">AirVibe Waveform Tracker</h1>
          <div className="text-sm opacity-80">Paste hex -&gt; decode -&gt; visualize</div>
        </header>

        <section className="grid gap-2 bg-slate-900/60 rounded-2xl p-4 ring-1 ring-slate-800">
          <div className="text-sm">
            Self-tests: <span className="text-emerald-400">{tests.passed} passed</span> • <span className="text-red-400">{tests.failed} failed</span>
          </div>
          <details className="text-xs opacity-90">
            <summary className="cursor-pointer">Show details</summary>
            <ul className="mt-2 list-disc pl-5 space-y-1">
              {tests.items.map((t, i) => (
                <li key={i} className={t.ok ? "text-emerald-300" : "text-red-300"}>
                  <span>{t.ok ? "PASS" : "FAIL"}</span>
                  <Sep />
                  <span>{sanitize(t.name)}</span>
                  {t.info ? (
                    <>
                      <Sep />
                      <span>{sanitize(t.info)}</span>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>
          </details>
        </section>

        <section className="grid gap-3 bg-slate-900/60 rounded-2xl p-4 ring-1 ring-slate-800">
          <div className="flex gap-2 flex-wrap">
            <button className="px-3 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700" onClick={fillExample}>
              Fill example
            </button>
            <button className="px-3 py-1.5 rounded-xl bg-emerald-700 hover:bg-emerald-600" onClick={onIngest}>
              Ingest
            </button>
          </div>
          <textarea
            className="w-full h-40 rounded-xl bg-slate-950 ring-1 ring-slate-800 p-3 font-mono text-xs"
            placeholder="Paste hex packets here, one per line (e.g., 0321...)"
            value={hexInput}
            onChange={(e) => setHexInput(e.target.value)}
          />
          {error && <div className="text-red-400 text-sm">{error}</div>}
        </section>

        <section className="grid gap-4">
          {activeTxIds.length === 0 && (
            <div className="text-slate-400 text-sm">No transactions yet. Paste packets above, or click Fill example.</div>
          )}
          {activeTxIds.map((txId) => {
            const tx = waves[txId];
            return (
              <div key={txId} className="rounded-2xl ring-1 ring-slate-800 bg-slate-900/60 p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-lg font-medium">
                    Transaction <span className="font-mono">0x{txId.toString(16).padStart(2, "0")}</span> ({txId})
                  </div>
                  <div className="text-sm flex gap-2 items-center">
                    {tx.params ? (
                      <span className="px-2 py-0.5 rounded-lg bg-slate-800 ring-1 ring-slate-700">
                        Axes: {tx.params.AxisSelectionText} • fs {tx.sr} Hz • segs {tx.expected} • N/axis {tx.samplesPerAxis}
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 rounded-lg bg-amber-900/60">Waiting for TWIU (Type 03)</span>
                    )}
                  </div>
                </div>

                <div className="grid gap-3">
                  {tx.expected && (
                    <div>
                      <div className="text-sm mb-2 opacity-80">Segment map</div>
                      <SegmentsGrid tx={tx} />
                    </div>
                  )}
                  <div>
                    <div className="text-sm opacity-80 mb-1">Suggested downlinks</div>
                    <div className="flex flex-wrap gap-2">
                      {tx.downlinks?.length ? (
                        tx.downlinks.map((d, i) => (
                          <div key={i} className="px-2 py-1 rounded-lg bg-slate-800 text-xs ring-1 ring-slate-700">
                            {d.label} • Port {d.port} • <span className="font-mono">{d.hex}</span>
                          </div>
                        ))
                      ) : (
                        <div className="text-xs text-slate-400">None yet.</div>
                      )}
                    </div>
                  </div>
                  {tx.params && (
                    <div className="grid gap-2">
                      <SvgWave tx={tx} />
                    </div>
                  )}
                  {tx.complete && (
                    <div className="flex">
                      <button
                        className="px-3 py-1.5 rounded-xl bg-blue-700 hover:bg-blue-600 text-sm"
                        onClick={() => handleDownload(tx)}
                      >
                        Download assembled CSV
                      </button>
                    </div>
                  )}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-sm opacity-80">Packet log</summary>
                    <div className="mt-2 grid gap-2">
                      {[...(tx.segments?.entries?.() ?? [])]
                        .sort((a, b) => a[0] - b[0])
                        .map(([segNo, pkt]) => (
                          <div key={segNo} className="rounded-xl bg-slate-950 ring-1 ring-slate-800 p-3">
                            <div className="text-sm mb-1">
                              Segment {segNo} • Type {pkt.PacketType === 5 ? "05 (last)" : "01"}
                            </div>
                            <CodeHex bytes={pkt._raw} />
                          </div>
                        ))}
                    </div>
                  </details>
                </div>
              </div>
            );
          })}
        </section>

        {log.length > 0 && (
          <section className="grid gap-2">
            <div className="text-sm opacity-80">Ingested packets ({log.length})</div>
            <div className="grid gap-2">
              {log.map((p, idx) => (
                <div key={idx} className="rounded-xl bg-slate-900/40 ring-1 ring-slate-800 p-3">
                  <div className="text-sm">
                    Type {p.PacketType.toString(16).padStart(2, "0").toUpperCase()} • TxID {p.TransactionID} • Seg {p.SegmentNumber}
                    {p.LastSegment ? " • last" : ""}
                  </div>
                  {p.PacketType === 3 && (
                    <div className="text-xs opacity-80">
                      Axes {p.AxisSelectionText}, Segments {p.NumberOfSegments}, SR {p.SamplingRate_Hz} Hz, Samples/axis {p.NumberOfSamplesEachAxis}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        <footer className="pt-2 text-xs text-slate-500">
          Demo assumptions: BE fields; tri-axial triplets in data segments; zero-fill for non-green segments. Yellow = requested missing after Type 05; red = gap below max-seen before 05.
        </footer>
      </div>
    </div>
  );
}
