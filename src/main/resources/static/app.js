'use strict';
/* Kubemap — topology graph, detail panel, all-namespaces overview. logs.js (pod logs) loads after this file. */

/* ================= config ================= */
const ICONS = {
  Ingress: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9M12 3C9.5 5.7 8.2 8.7 8.2 12s1.3 6.3 3.8 9"/>',
  Service: '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="5.5" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M8.4 10.8l7.2-4M8.4 13.2l7.2 4"/>',
  Deployment: '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5L12 21l9-4.5"/>',
  StatefulSet: '<ellipse cx="12" cy="5.5" rx="8" ry="2.8"/><path d="M4 5.5v13c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8v-13"/><path d="M4 12c0 1.5 3.6 2.8 8 2.8s8-1.3 8-2.8"/>',
  DaemonSet: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  CronJob: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>',
  Job: '<circle cx="12" cy="12" r="9"/><path d="M8.5 12.5l2.5 2.5 4.5-5"/>',
  ReplicaSet: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  Pod: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>',
  HorizontalPodAutoscaler: '<path d="M3 21h18"/><path d="M6 17v-5M11 17V9M16 17v-3"/><path d="M15 6l3-3 3 3M18 3v8"/>',
  ConfigMap: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6M8 13h8M8 17h5"/>',
  Secret: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4M12 15v2"/>',
  PersistentVolumeClaim: '<path d="M22 12H2"/><path d="M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/><path d="M6 16h.01M10 16h.01"/>',
  PersistentVolume: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6"/>',
  StorageClass: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v4c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 9v4c0 1.7 3.6 3 8 3s8-1.3 8-3V9M4 13v4c0 1.7 3.6 3 8 3s8-1.3 8-3v-4"/>',
  Node: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01"/>',
  ServiceAccount: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-7 8-7s8 3 8 7"/>',
  RBAC: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M15 8l2 2"/>',
  RoleBinding: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  PodDisruptionBudget: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  NetworkPolicy: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M3 15h18M9 4v6M15 10v5M9 15v5"/>',
  IngressClass: '<path d="M3 21h18M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M14 12h.01"/>',
  Custom: '<path d="M10 3h4v2.5a2 2 0 1 0 4 0V3h3v7h-2.5a2 2 0 1 0 0 4H21v7h-7v-2.5a2 2 0 1 0-4 0V21H3v-7h2.5a2 2 0 1 0 0-4H3V3z"/>',
};
Object.assign(ICONS, {
  ResourceQuota: '<path d="M12 3a9 9 0 1 0 9 9h-9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>',
  LimitRange: '<path d="M4 7h16M4 17h16"/><path d="M8 4v6M16 14v6"/>',
  ReplicationController: '<rect x="3" y="8" width="13" height="13" rx="2"/><path d="M8 8V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3"/>',
  PriorityClass: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
  RuntimeClass: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M1 9h3M1 15h3M20 9h3M20 15h3"/>',
  MutatingWebhookConfiguration: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/><path d="M17 17l4 4"/>',
  ValidatingWebhookConfiguration: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  ValidatingAdmissionPolicy: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 9h6M9 13h6"/>',
  ValidatingAdmissionPolicyBinding: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M10 14a2 2 0 0 0 3 0l2-2a2 2 0 0 0-3-3"/>',
  CertificateSigningRequest: '<rect x="3" y="4" width="18" height="13" rx="2"/><circle cx="12" cy="10" r="2.5"/><path d="M10 13l-1 7 3-2 3 2-1-7"/>',
  APIService: '<path d="M8 3H6a2 2 0 0 0-2 2v4l-2 3 2 3v4a2 2 0 0 0 2 2h2M16 3h2a2 2 0 0 1 2 2v4l2 3-2 3v4a2 2 0 0 1-2 2h-2"/>',
  VolumeAttachment: '<ellipse cx="9" cy="6" rx="6" ry="2.5"/><path d="M3 6v8c0 1.4 2.7 2.5 6 2.5M15 6v4"/><path d="M15 14h7M18.5 10.5L22 14l-3.5 3.5"/>',
  CSIDriver: '<rect x="3" y="7" width="18" height="10" rx="2"/><path d="M7 7V4M12 7V4M17 7V4M7 17v3M12 17v3M17 17v3"/>',
  CSINode: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M15 6.5h3M15 17.5h3"/>',
  Lease: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M5 5l2 2"/>',
  Gateway: '<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-7h6v7"/>',
  GatewayClass: '<path d="M3 21V9l9-6 9 6v12z"/><path d="M8 13h8M8 17h8"/>',
  HTTPRoute: '<circle cx="5" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.5 6H14a4 4 0 0 1 0 8h-4a4 4 0 0 0 0 8"/>',
  Middleware: '<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="1.8"/><circle cx="15" cy="12" r="1.8"/><circle cx="7" cy="18" r="1.8"/>',
});
ICONS.GRPCRoute = ICONS.TCPRoute = ICONS.TLSRoute = ICONS.UDPRoute = ICONS.IngressRoute = ICONS.IngressRouteTCP = ICONS.IngressRouteUDP = ICONS.HTTPRoute;
ICONS.MiddlewareTCP = ICONS.Middleware; ICONS.TraefikService = ICONS.Service;
ICONS.Role = ICONS.ClusterRole = ICONS.RBAC;
ICONS.Quota = ICONS.ResourceQuota; ICONS.Admission = ICONS.ValidatingWebhookConfiguration; ICONS.CSI = ICONS.CSIDriver; ICONS.Scheduling = ICONS.PriorityClass;
ICONS.ClusterRoleBinding = ICONS.RoleBinding;

const KINDS = {
  Ingress:                 { label: 'Ingress',     color: '#a371f7' },
  Service:                 { label: 'Service',     color: '#3b82f6' },
  Deployment:              { label: 'Deployment',  color: '#06b6d4' },
  StatefulSet:             { label: 'StatefulSet', color: '#14b8a6' },
  DaemonSet:               { label: 'DaemonSet',   color: '#0ea5e9' },
  CronJob:                 { label: 'CronJob',     color: '#f59e0b' },
  Job:                     { label: 'Job',         color: '#f97316' },
  ReplicaSet:              { label: 'ReplicaSet',  color: '#7c8aa5' },
  Pod:                     { label: 'Pod',         color: '#22c55e' },
  HorizontalPodAutoscaler: { label: 'HPA',         color: '#84cc16' },
  PersistentVolumeClaim:   { label: 'PVC',         color: '#818cf8' },
  PersistentVolume:        { label: 'PV',          color: '#6366f1' },
  StorageClass:            { label: 'StorageClass', color: '#8b5cf6' },
  ConfigMap:               { label: 'ConfigMap',   color: '#94a3b8' },
  Secret:                  { label: 'Secret',      color: '#e879f9' },
  ServiceAccount:          { label: 'ServiceAccount', color: '#fb7185' },
  Role:                    { label: 'Role',        color: '#f43f5e' },
  ClusterRole:             { label: 'ClusterRole', color: '#e11d48' },
  RoleBinding:             { label: 'RoleBinding', color: '#fda4af' },
  ClusterRoleBinding:      { label: 'ClusterRoleBinding', color: '#fb7185' },
  PodDisruptionBudget:     { label: 'PDB',         color: '#eab308' },
  NetworkPolicy:           { label: 'NetworkPolicy', color: '#f97316' },
  IngressClass:            { label: 'IngressClass', color: '#c084fc' },
  Node:                    { label: 'Node',        color: '#a8a29e' },
  ReplicationController:   { label: 'ReplicationController', color: '#64748b' },
  ResourceQuota:           { label: 'ResourceQuota', color: '#10b981' },
  LimitRange:              { label: 'LimitRange',  color: '#34d399' },
  PriorityClass:           { label: 'PriorityClass', color: '#fbbf24' },
  RuntimeClass:            { label: 'RuntimeClass', color: '#a3a3a3' },
  MutatingWebhookConfiguration:   { label: 'MutatingWebhook', color: '#f472b6' },
  ValidatingWebhookConfiguration: { label: 'ValidatingWebhook', color: '#ec4899' },
  ValidatingAdmissionPolicy:        { label: 'AdmissionPolicy', color: '#db2777' },
  ValidatingAdmissionPolicyBinding: { label: 'PolicyBinding', color: '#f9a8d4' },
  APIService:              { label: 'APIService',  color: '#38bdf8' },
  CertificateSigningRequest: { label: 'CSR',       color: '#facc15' },
  VolumeAttachment:        { label: 'VolumeAttachment', color: '#a5b4fc' },
  CSIDriver:               { label: 'CSIDriver',   color: '#7c3aed' },
  CSINode:                 { label: 'CSINode',     color: '#78716c' },
  Lease:                   { label: 'Lease',       color: '#94a3b8' },
};
/* well-known custom resources (Gateway API, Traefik): own colours / icons / columns instead of the generic "Custom" look */
const KNOWN_CR = {
  Gateway: { label: 'Gateway', color: '#8b5cf6' }, GatewayClass: { label: 'GatewayClass', color: '#a78bfa' },
  HTTPRoute: { label: 'HTTPRoute', color: '#c084fc' }, GRPCRoute: { label: 'GRPCRoute', color: '#c084fc' },
  TCPRoute: { label: 'TCPRoute', color: '#c084fc' }, TLSRoute: { label: 'TLSRoute', color: '#c084fc' }, UDPRoute: { label: 'UDPRoute', color: '#c084fc' },
  IngressRoute: { label: 'IngressRoute', color: '#a371f7' }, IngressRouteTCP: { label: 'IngressRouteTCP', color: '#a371f7' },
  IngressRouteUDP: { label: 'IngressRouteUDP', color: '#a371f7' },
  Middleware: { label: 'Middleware', color: '#2dd4bf' }, MiddlewareTCP: { label: 'MiddlewareTCP', color: '#2dd4bf' },
  TraefikService: { label: 'TraefikService', color: '#3b82f6' },
};
const CUSTOM = { label: 'Custom', color: '#f472b6' };
const RBAC_KINDS = ['Role', 'RoleBinding', 'ClusterRole', 'ClusterRoleBinding'];
/* kinds that share one filter chip */
const CHIP_GROUP = {
  ResourceQuota: 'Quota', LimitRange: 'Quota',
  PriorityClass: 'Scheduling', RuntimeClass: 'Scheduling',
  MutatingWebhookConfiguration: 'Admission', ValidatingWebhookConfiguration: 'Admission', ValidatingAdmissionPolicy: 'Admission',
  ValidatingAdmissionPolicyBinding: 'Admission', APIService: 'Admission',
  VolumeAttachment: 'CSI', CSIDriver: 'CSI', CSINode: 'CSI',
};

/* filter chips (one chip can cover several kinds) */
const CHIPS = [
  { id: 'Ingress', on: true, short: 'ing' }, { id: 'Service', on: true, short: 'svc' }, { id: 'Deployment', on: true, short: 'deploy' },
  { id: 'StatefulSet', on: true, short: 'sts' }, { id: 'DaemonSet', on: true, short: 'ds' }, { id: 'CronJob', on: true, short: 'cj' },
  { id: 'Job', on: true, short: 'job' }, { id: 'ReplicaSet', on: true, short: 'rs' }, { id: 'Pod', on: true, short: 'pod' },
  { id: 'HorizontalPodAutoscaler', on: true, short: 'hpa' }, { id: 'PersistentVolumeClaim', on: true, short: 'pvc' },
  { id: 'PersistentVolume', on: true, short: 'pv' },
  { id: 'Custom', on: true, label: 'Custom', short: 'crd', color: CUSTOM.color, title: 'Custom resources (CRD)' },
  // less common kinds live in the "Thêm" menu
  { id: 'ConfigMap', on: false, more: true }, { id: 'Secret', on: false, more: true },
  { id: 'ServiceAccount', on: false, more: true },
  { id: 'RBAC', on: false, more: true, label: 'RBAC', color: '#f43f5e', title: 'Role, RoleBinding, ClusterRole, ClusterRoleBinding' },
  { id: 'PodDisruptionBudget', on: false, more: true }, { id: 'NetworkPolicy', on: false, more: true, label: 'NetworkPolicy' },
  { id: 'StorageClass', on: false, more: true }, { id: 'IngressClass', on: false, more: true }, { id: 'Node', on: false, more: true },
  { id: 'ReplicationController', on: true, short: 'rc' },
  // admission webhooks / aggregated APIs break things cluster-wide when they fail: on by default (they are few)
  { id: 'Admission', on: true, label: 'Admission & API', short: 'adm', color: '#ec4899', title: 'MutatingWebhook, ValidatingWebhook, ValidatingAdmissionPolicy (+Binding), APIService' },
  { id: 'Quota', on: false, more: true, label: 'Quota & LimitRange', color: '#10b981', title: 'ResourceQuota, LimitRange' },
  { id: 'Scheduling', on: false, more: true, label: 'PriorityClass & RuntimeClass', color: '#fbbf24', title: 'PriorityClass, RuntimeClass' },
  { id: 'CertificateSigningRequest', on: false, more: true },
  { id: 'CSI', on: false, more: true, label: 'CSI', color: '#7c3aed', title: 'VolumeAttachment, CSIDriver, CSINode' },
  { id: 'Lease', on: false, more: true },
];
const chipOn = {};

/* edge type -> [label when outgoing, label when incoming] */
const REL = {
  owns: ['Quản lý', 'Thuộc về'], selects: ['Chọn tới', 'Được chọn bởi'], routes: ['Định tuyến tới', 'Nhận traffic từ'],
  'runs-on': ['Chạy trên', 'Đang chạy'], mounts: ['Sử dụng', 'Được dùng bởi'], binds: ['Gắn với', 'Được gắn bởi'],
  uses: ['Dùng service', 'Được dùng bởi'], tls: ['Chứng chỉ TLS', 'Làm TLS cho'], class: ['Thuộc class', 'Là class của'],
  pulls: ['Pull image bằng', 'Dùng để pull image cho'], 'runs-as': ['Chạy với ServiceAccount', 'Được dùng bởi'],
  grants: ['Cấp quyền theo', 'Được gán qua'], subject: ['Cấp quyền cho', 'Được cấp quyền qua'],
  scales: ['Tự động scale', 'Được scale bởi'], protects: ['Bảo vệ', 'Được bảo vệ bởi'], applies: ['Áp dụng cho', 'Chịu policy'],
  controller: ['Được xử lý bởi', 'Ingress controller của'],
  priority: ['Độ ưu tiên', 'Là độ ưu tiên của'], runtime: ['Chạy bằng RuntimeClass', 'Là runtime của'],
  calls: ['Gọi tới', 'Được gọi bởi'], parent: ['Gắn vào', 'Nhận route'], middleware: ['Dùng middleware', 'Là middleware của'],
  attaches: ['Gắn vào', 'Được gắn bởi'], driver: ['Dùng CSI driver', 'Là CSI driver của'], held: ['Đang được giữ bởi', 'Giữ lease'],
};
const EDGE_GROUP = {
  owns: 'own', selects: 'traffic', routes: 'traffic', uses: 'traffic',
  mounts: 'dep', 'runs-on': 'dep', binds: 'dep', tls: 'dep', class: 'dep', pulls: 'dep', 'runs-as': 'dep',
  scales: 'policy', protects: 'policy', applies: 'policy', grants: 'policy', subject: 'policy', controller: 'traffic',
  priority: 'dep', runtime: 'dep', calls: 'traffic', parent: 'traffic', middleware: 'dep', attaches: 'dep', driver: 'dep', held: 'policy',
};
const CARD_W = 232, CARD_H = 64, TILE_W = 300, TILE_H = 128;
const MIN_READABLE_ZOOM = 0.7; // below this card text is too small to read
const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, sans-serif';
const CLUSTER = '~cluster';
const LOD_ZOOM = 0.4;

/* ================= state & utils ================= */
const $ = id => document.getElementById(id);
const state = { graph: null, es: null, structureKey: '', first: true, health: null, query: '', hovered: null, selected: null,
  panelNs: null, expanded: new Set(), focusNs: null, manual: new Map(), systemNs: [/^kube-/], details: { id: null, at: 0, data: null } };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get: k => { try { return localStorage.getItem('k8s-studio.' + k); } catch { return null; } },
                set: (k, v) => { try { localStorage.setItem('k8s-studio.' + k, v); } catch {} } };
const EDGE_MODES = { curve: 'Đường cong', taxi: 'Gấp khúc bo góc', straight: 'Đường thẳng' };
let edgeMode = EDGE_MODES[store.get('edgeMode')] ? store.get('edgeMode') : 'curve';
const icon = (kind, cls = 'i') => `<svg class="${cls}" viewBox="0 0 24 24">${ICONS[kind] || ICONS.Custom}</svg>`;
const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const H = h => (['ok', 'warn', 'error'].includes(h) ? h : 'unknown');
const healthColor = h => css('--' + H(h));
const kindInfo = n => (n.group ? KNOWN_CR[n.kind] || { ...CUSTOM, label: n.kind } : KINDS[n.kind] || KNOWN_CR[n.kind] || { ...CUSTOM, label: n.kind });
const iconKind = n => (ICONS[n.kind] && (!n.group || KNOWN_CR[n.kind]) ? n.kind : 'Custom');
const chipOf = n => (n.group ? 'Custom' : RBAC_KINDS.includes(n.kind) ? 'RBAC' : CHIP_GROUP[n.kind] || (KINDS[n.kind] ? n.kind : 'Custom'));
const isVisible = n => (n.missing || chipOn[chipOf(n)]) && (n.kind !== 'Node' || nodeCardWanted(n));
/* every Node comes with the graph (for the node bar); in one namespace only those running its pods get a card, as before */
const nodeCardWanted = n => isAll() || (state.graph?.edges || []).some(e => e.type === 'runs-on' && e.target === n.id);
const isAll = () => $('ns').value === '*';
const isSystemNs = ns => ns === CLUSTER || state.systemNs.some(r => r.test(ns));

try { JSON.parse(store.get('expanded') || '[]').forEach(ns => state.expanded.add(ns)); } catch {}
const saveExpanded = () => store.set('expanded', JSON.stringify([...state.expanded]));

function truncMid(s, max) {
  s = String(s ?? '');
  if (s.length <= max) return s;
  const tail = Math.ceil((max - 1) * 0.4), head = max - 1 - tail;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}
const truncEnd = (s, max) => { s = String(s ?? ''); return s.length <= max ? s : s.slice(0, max - 1) + '…'; };

/* cut text to a pixel width (proportional fonts: character counts are not reliable); middle cut keeps pod hash suffixes */
const measureCtx = document.createElement('canvas').getContext('2d');
function fitText(text, px, weight, maxW, middle) {
  text = String(text ?? '');
  measureCtx.font = `${weight} ${px}px ${FONT}`;
  const w = t => measureCtx.measureText(t).width;
  if (w(text) <= maxW) return text;
  let lo = 1, hi = text.length;
  while (lo < hi) { // longest number of kept characters that still fits
    const mid = Math.ceil((lo + hi) / 2);
    (w(middle ? truncMid(text, mid) : truncEnd(text, mid)) <= maxW) ? lo = mid : hi = mid - 1;
  }
  return middle ? truncMid(text, lo) : truncEnd(text, lo);
}
function age(ts) {
  if (!ts) return null;
  const s = Math.max(0, (Date.now() - Date.parse(ts)) / 1000);
  if (s < 60) return Math.floor(s) + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h' + (s < 36000 ? ' ' + Math.floor(s % 3600 / 60) + 'm' : '');
  return Math.floor(s / 86400) + 'd';
}

/* ================= theme ================= */
let cyRef = null; // set once cytoscape exists (window.cy would be the #cy div!)
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  $('theme').innerHTML = t === 'dark'
    ? '<svg class="i" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
    : '<svg class="i" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
  if (cyRef) {
    cyRef.style(cyStyle());
    cyRef.nodes('.card').forEach(n => n.data({ img: cardImage(n.data('raw')), imgH: cardImage(n.data('raw'), true), imgS: cardImage(n.data('raw'), false, true) }));
    cyRef.nodes('.tile').forEach(n => n.data({ img: tileImage(n.data('summary')), imgH: tileImage(n.data('summary'), true) }));
    routeEdges();
  }
}
applyTheme(new URLSearchParams(location.search).get('theme') || store.get('theme')
  || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));

/* ================= SVG images drawn into the canvas ================= */
const svgUri = svg => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
const SHADOW_PAD = 16; // transparent margin around cards/tiles so the shadow isn't clipped

/* wraps card/tile content: resting = barely-there shadow, hovered = lifted 2px with a deeper, wider shadow */
function elevated(inner, w, h, hovered) {
  const P = SHADOW_PAD, dark = document.documentElement.dataset.theme !== 'light';
  const sh = hovered ? { dy: 7, blur: 8, op: dark ? 0.55 : 0.18 } : { dy: 1.5, blur: 2, op: dark ? 0.35 : 0.07 };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${(w + 2 * P) * 2}" height="${(h + 2 * P) * 2}" viewBox="0 0 ${w + 2 * P} ${h + 2 * P}">
    <defs><filter id="sh" x="-20%" y="-30%" width="140%" height="180%">
      <feDropShadow dx="0" dy="${sh.dy}" stdDeviation="${sh.blur}" flood-color="#000" flood-opacity="${sh.op}"/></filter></defs>
    <g transform="translate(${P},${P - (hovered ? 2 : 0)})" filter="url(#sh)">${inner}</g></svg>`;
}
const cardH = () => CARD_H; // every card the same height; the reason (exit code, image, …) is shown in the side panel

/*
 * Bottom line of a card: what state it's in (left) and, for things with a ready ratio (workloads' replicas, a
 * Service's endpoints), that ratio as a coloured pill on the right — instead of "ClusterIP · 1/1 endpoint" in one string.
 */
function cardParts(n) {
  const info = n.info || {};
  const raw = [info.replicas, info.ready, info.endpoints, /^\d+\/\d+$/.test(n.status || '') ? n.status : null].find(v => /^\d+\/\d+/.test(String(v || '')));
  const m = raw && /^(\d+)\/(\d+)/.exec(raw);
  let left = String(n.status || (n.health === 'unknown' ? 'tham chiếu' : ''));
  if (m && !n.missing) {
    left = left.replace(/\s*·?\s*\d+\/\d+(\s*endpoint)?\s*$/, '').trim();
    if (!left || /^\d+\/\d+$/.test(left))
      left = n.health === 'ok' ? 'Sẵn sàng' : n.reason || (+m[1] === 0 ? (+m[2] === 0 ? 'Không chạy' : 'Không pod nào sẵn sàng') : 'Chưa đủ pod sẵn sàng');
    else if (n.health !== 'ok' && n.reason) left = n.reason;
  }
  return { left, ratio: m && !n.missing ? [+m[1], +m[2]] : null };
}

function cardImage(n, hovered = false, selected = false) {
  const k = kindInfo(n), ik = iconKind(n);
  const w = CARD_W, h = cardH(n), hc = healthColor(n.health);
  const card = css('--card');
  const border = selected ? css('--accent') : n.missing || n.health === 'error' ? hc : hovered ? css('--accent') : css('--border-strong');
  const { left: status, ratio } = cardParts(n);
  const iy = 13;
  // the ratio pill, right-aligned on the status line
  let pill = '', statusMax = w - 72.5 - 12;
  if (ratio) {
    const txt = `${ratio[0]}/${ratio[1]}`, pw = Math.round(txt.length * 6.6 + 12);
    const pc = ratio[1] === 0 || (ratio[0] < ratio[1] && n.health === 'ok') ? css('--unknown') : ratio[0] >= ratio[1] ? css('--ok') : ratio[0] === 0 ? css('--error') : css('--warn');
    pill = `<rect x="${w - 12 - pw}" y="44" width="${pw}" height="16" rx="5" fill="${pc}" fill-opacity="0.14"/>
      <text x="${w - 12 - pw / 2}" y="55.5" text-anchor="middle" font-family="ui-monospace, SF Mono, Menlo, monospace" font-size="10.5" font-weight="700" fill="${pc}">${txt}</text>`;
    statusMax -= pw + 8;
  }
  const svg = `<g>
    <rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="12" fill="${card}" stroke="${border}"
      stroke-width="${selected ? 2.2 : n.missing || n.health === 'error' ? 1.6 : 1}" ${n.missing && !selected ? 'stroke-dasharray="5 4"' : ''}/>
    ${n.missing ? `<rect x="1.5" y="1.5" width="${w - 3}" height="${h - 3}" rx="11" fill="${hc}" fill-opacity="0.07"/>`
                : `<rect x="1.5" y="13" width="3" height="${h - 26}" rx="1.5" fill="${hc}"/>`}
    <rect x="13" y="${iy}" width="38" height="38" rx="10" fill="${k.color}" fill-opacity="${n.missing ? 0.08 : 0.16}"/>
    <g transform="translate(22,${iy + 9}) scale(0.8333)" fill="none" stroke="${n.missing ? hc : k.color}" stroke-width="2"
       stroke-linecap="round" stroke-linejoin="round" ${n.missing ? 'stroke-dasharray="3 2.5"' : ''}>${ICONS[ik]}</g>
    <text x="61" y="20" font-family="${FONT}" font-size="10" font-weight="700" letter-spacing="0.6" fill="${css('--muted')}">${esc(fitText(k.label.toUpperCase() + (n.note ? '  ·  ' + n.note : ''), 10.6, 700, w - 61 - 12))}</text>
    <text x="61" y="38" font-family="${FONT}" font-size="13.5" font-weight="600" fill="${css('--text')}">${esc(fitText(n.name, 13.5, 600, w - 61 - 12, true))}</text>
    <circle cx="64.5" cy="51" r="3.2" fill="${hc}"/>
    <text x="72.5" y="55" font-family="${FONT}" font-size="11" fill="${n.health === 'ok' ? css('--muted') : hc}">${esc(fitText(status, 11, 400, statusMax, true))}</text>
    ${pill}
  </g>`;
  return svgUri(elevated(svg, w, h, hovered && !selected));
}

function tileImage(s, hovered = false) {
  const w = TILE_W, h = TILE_H;
  const tone = s.err ? css('--error') : s.warn ? css('--warn') : css('--border-strong');
  const ok = css('--ok'), warn = css('--warn'), err = css('--error'), muted = css('--muted'), faint = css('--faint');
  const barW = w - 36, pods = s.podOk + s.podWarn + s.podErr;
  let bar = `<rect x="18" y="64" width="${barW}" height="6" rx="3" fill="${css('--surface-2')}"/>`;
  if (pods) {
    let x = 18;
    for (const [n, c] of [[s.podOk, ok], [s.podWarn, warn], [s.podErr, err]]) {
      if (!n) continue;
      const bw = barW * n / pods;
      bar += `<rect x="${x}" y="64" width="${bw}" height="6" fill="${c}"/>`;
      x += bw;
    }
    bar = `<clipPath id="c"><rect x="18" y="64" width="${barW}" height="6" rx="3"/></clipPath><g clip-path="url(#c)">${bar}</g>`;
  }
  const dots = [[s.err, err, 'lỗi'], [s.warn, warn, 'cảnh báo'], [s.ok, ok, 'ổn']].filter(d => d[0] || d[2] === 'ổn');
  let dx = 18, dotsSvg = '';
  for (const [n, c, l] of dots) {
    const t = `${n} ${l}`;
    dotsSvg += `<circle cx="${dx + 4}" cy="93" r="4" fill="${c}"/><text x="${dx + 12}" y="97" font-family="${FONT}" font-size="12" fill="${css('--text')}">${t}</text>`;
    dx += 22 + t.length * 6.6;
  }
  const svg = `<g>
    <rect x="0.75" y="0.75" width="${w - 1.5}" height="${h - 1.5}" rx="14" fill="${css('--card')}" stroke="${hovered && !s.err && !s.warn ? css('--accent') : tone}"
      stroke-width="${s.err ? 1.8 : 1.2}" ${s.system ? 'stroke-dasharray="6 4"' : ''}/>
    <text x="18" y="31" font-family="${FONT}" font-size="15.5" font-weight="700" fill="${css('--text')}">${esc(fitText(s.label, 15.5, 700, s.system ? w - 18 - 96 : w - 36, true))}</text>
    ${s.system ? `<rect x="${w - 84}" y="16" width="66" height="20" rx="10" fill="${faint}" fill-opacity="0.18"/>
      <text x="${w - 51}" y="30" text-anchor="middle" font-family="${FONT}" font-size="10.5" fill="${muted}">hệ thống</text>` : ''}
    <text x="18" y="52" font-family="${FONT}" font-size="11.5" fill="${muted}">${esc(fitText(s.line, 11.5, 400, w - 36))}</text>
    ${bar}
    ${dotsSvg}
    <text x="18" y="118" font-family="${FONT}" font-size="10.5" fill="${faint}">Bấm để mở rộng</text>
  </g>`;
  return svgUri(elevated(svg, w, h, hovered));
}

/* ================= cytoscape ================= */
function edgeShape() {
  if (edgeMode === 'taxi') return { 'curve-style': 'round-taxi', 'taxi-direction': 'rightward', 'taxi-turn': '50%', 'taxi-radius': 12 };
  if (edgeMode === 'straight') return { 'curve-style': 'straight' };
  return { 'curve-style': 'unbundled-bezier', 'control-point-weights': '0.25 0.75', 'control-point-distances': '0 0' };
}

/* summary label of a namespace box when zoomed far out: ~15px on screen, but never bigger than the box allows */
function lodFont(ele) {
  const z = Math.max(cy.zoom(), 0.03);
  return Math.max(1, Math.min(15 / z, ele.width() * 0.075, ele.height() * 0.14));
}

function cyStyle() {
  const muted = css('--muted'), faint = css('--faint'), accent = css('--accent'), policy = '#a78bfa', error = css('--error');
  return [
    { selector: 'node.card', style: {
      'shape': 'round-rectangle', 'width': CARD_W, 'height': 'data(h)', 'background-opacity': 0, 'border-width': 0,
      'background-image': 'data(img)', 'background-clip': 'none', 'bounds-expansion': SHADOW_PAD,
      'background-width': `${(CARD_W + 2 * SHADOW_PAD) / CARD_W * 100}%`,
      'background-height': ele => `${(ele.data('h') + 2 * SHADOW_PAD) / ele.data('h') * 100}%`,
      'underlay-shape': 'round-rectangle', 'underlay-padding': 0, 'underlay-opacity': 0,
      'overlay-shape': 'round-rectangle', 'overlay-padding': 3, 'overlay-opacity': 0,
      'transition-property': 'opacity', 'transition-duration': '180ms',
    }},
    { selector: 'node.card.hover', style: { 'background-image': 'data(imgH)', 'z-index': 999 } },
    { selector: 'node.card:selected', style: { 'background-image': 'data(imgS)' } }, // wins over hover: no lift/shadow once clicked
    { selector: 'node:active', style: { 'overlay-opacity': 0 } },
    { selector: 'node.tile', style: {
      'shape': 'round-rectangle', 'width': TILE_W, 'height': TILE_H, 'background-opacity': 0, 'border-width': 0,
      'background-image': 'data(img)', 'background-clip': 'none', 'bounds-expansion': SHADOW_PAD,
      'background-width': `${(TILE_W + 2 * SHADOW_PAD) / TILE_W * 100}%`, 'background-height': `${(TILE_H + 2 * SHADOW_PAD) / TILE_H * 100}%`,
      'underlay-shape': 'round-rectangle', 'underlay-opacity': 0, 'overlay-shape': 'round-rectangle', 'overlay-opacity': 0,
      'transition-property': 'opacity', 'transition-duration': '180ms',
    }},
    { selector: 'node.tile.hover', style: { 'background-image': 'data(imgH)', 'z-index': 999 } },
    { selector: 'node.colhead, node.isohead', style: {
      'shape': 'rectangle', 'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0, 'events': 'no',
      'label': 'data(label)', 'text-valign': 'center', 'font-family': FONT, 'font-size': 11.5, 'font-weight': 700,
      'color': muted, 'text-transform': 'uppercase', 'text-max-width': CARD_W, 'text-wrap': 'ellipsis',
    }},
    { selector: 'node.colhead', style: { 'text-halign': 'center' } },
    { selector: 'node.isohead', style: { 'text-halign': 'right', 'text-max-width': 600, 'color': faint } },
    { selector: 'node.section', style: {
      'shape': 'rectangle', 'width': 1, 'height': 1, 'background-opacity': 0, 'border-width': 0, 'events': 'no',
      'label': 'data(label)', 'text-halign': 'right', 'text-valign': 'center', 'font-family': FONT, 'font-size': 13,
      'font-weight': 700, 'color': muted, 'text-transform': 'uppercase',
    }},
    { selector: 'node.group', style: {
      'shape': 'round-rectangle', 'corner-radius': 18, 'background-color': css('--surface'), 'background-opacity': 0.6,
      'border-width': 1, 'border-style': 'solid', 'border-color': css('--border-strong'), 'padding': 26,
      'label': 'data(label)', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -12,
      'font-family': FONT, 'font-size': 20, 'font-weight': 700, 'color': css('--text'),
      'overlay-opacity': 0, 'transition-property': 'border-color, background-opacity, background-color', 'transition-duration': '180ms',
    }},
    { selector: 'node.group.system', style: { 'border-style': 'dashed', 'color': muted } },
    { selector: 'node.group.hover', style: { 'border-color': accent, 'background-opacity': 0.85 } },
    { selector: 'edge', style: {
      'width': 1.6, 'line-color': muted, 'target-arrow-color': muted, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.7,
      ...edgeShape(),
      'source-endpoint': `${CARD_W / 2}px 0px`, 'target-endpoint': `${-CARD_W / 2 - 1}px 0px`,
      'line-cap': 'round', 'opacity': 0.7,
      'transition-property': 'opacity, line-color, width', 'transition-duration': '150ms',
    }},
    { selector: 'edge[g="traffic"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [6, 4], 'line-color': accent, 'target-arrow-color': accent, 'opacity': 0.8 } },
    { selector: 'edge[g="dep"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [1.5, 4], 'line-color': faint, 'target-arrow-color': faint, 'opacity': 0.6 } },
    { selector: 'edge[g="policy"]', style: { 'line-style': 'dashed', 'line-dash-pattern': [8, 3, 2, 3], 'line-color': policy, 'target-arrow-color': policy, 'opacity': 0.75 } },
    { selector: 'edge[?via]', style: { 'line-style': 'dashed', 'line-dash-pattern': [3, 3], 'opacity': 0.5 } },
    { selector: 'edge[?broken]', style: { 'line-color': error, 'target-arrow-color': error, 'opacity': 0.9 } },
    { selector: '.faded', style: { 'opacity': 0.3 } },
    { selector: 'edge.lit', style: { 'width': 2.4, 'opacity': 1, 'line-color': accent, 'target-arrow-color': accent, 'z-index': 10,
      'line-style': 'dashed', 'line-dash-pattern': [8, 5] } }, // highlighted links run too (see flow animation)
    // level of detail must come last so it wins over the per-edge-type opacity rules
    { selector: 'node.group.lod', style: {
      'label': 'data(lodLabel)', 'text-valign': 'center', 'text-margin-y': 0, 'text-wrap': 'wrap', 'line-height': 1.5,
      'text-max-width': ele => ele.width() * 0.9, 'font-size': lodFont, 'text-opacity': ele => (lodFont(ele) * cy.zoom() < 7 ? 0 : 1),
      'background-color': 'data(hcolor)', 'background-opacity': 0.14, 'border-color': 'data(hcolor)', 'border-width': 2,
    }},
    { selector: 'node.card.lod', style: { 'opacity': 0, 'events': 'no' } },
    { selector: 'edge.lod', style: { 'opacity': 0 } },
  ];
}
const cy = cyRef = cytoscape({ container: $('cy'), style: cyStyle(), minZoom: 0.05, maxZoom: 2.5, boxSelectionEnabled: false });

/* ----- smooth S-curves: control points computed per edge (see edge styles) ----- */
function routeEdge(e) {
  const s = e.source(), t = e.target();
  if (s.same(t)) return;
  const sp = s.position(), tp = t.position();
  const a = { x: sp.x + s.width() / 2, y: sp.y }, b = { x: tp.x - t.width() / 2, y: tp.y };
  const dx = b.x - a.x;
  let pts;
  // an edge that skips columns would run straight through the cards in between: detour above (or below) them
  const blockers = dx > CARD_W ? cy.nodes('.card').filter(n => {
    if (n.same(s) || n.same(t) || n.hasClass('lod')) return false;
    const bb = n.boundingBox({ includeLabels: false });
    if (bb.x2 < a.x + 20 || bb.x1 > b.x - 20) return false;
    const yAt = x => a.y + (b.y - a.y) * (x - a.x) / dx; // straight line between the two ends
    const y1 = yAt(Math.max(bb.x1, a.x)), y2 = yAt(Math.min(bb.x2, b.x));
    return Math.max(y1, y2) > bb.y1 - 6 && Math.min(y1, y2) < bb.y2 + 6;
  }) : cy.collection();
  if (blockers.nonempty()) {
    const bb = blockers.boundingBox({ includeLabels: false });
    const above = bb.y1 - 18, below = bb.y2 + 18;
    const lane = Math.abs(above - (a.y + b.y) / 2) <= Math.abs(below - (a.y + b.y) / 2) ? above : below;
    // climb/descend inside the gap between columns, never over a card
    const ramp = COL_GAP - 30;
    pts = [{ x: a.x + 18, y: a.y }, { x: a.x + ramp, y: lane }, { x: b.x - ramp, y: lane }, { x: b.x - 18, y: b.y }];
  } else {
    const k = dx > 0 ? Math.max(24, dx * 0.5) : 60 + Math.abs(dx) * 0.25; // backwards edges loop around
    pts = [{ x: a.x + k, y: a.y }, { x: b.x - k, y: b.y }];
  }
  const vx = tp.x - sp.x, vy = tp.y - sp.y, len = Math.hypot(vx, vy);
  if (len < 1) return;
  const ux = vx / len, uy = vy / len, nx = -uy, ny = ux;
  const w = pts.map(p => (((p.x - sp.x) * ux + (p.y - sp.y) * uy) / len).toFixed(4));
  const d = pts.map(p => ((p.x - sp.x) * nx + (p.y - sp.y) * ny).toFixed(2));
  e.style({ 'control-point-weights': w.join(' '), 'control-point-distances': d.join(' ') });
}
let routeQueued = false;
function routeEdges() {
  if (routeQueued || edgeMode !== 'curve') return;
  routeQueued = true;
  requestAnimationFrame(() => { routeQueued = false; cy.batch(() => cy.edges().forEach(routeEdge)); });
}
cy.on('position', 'node.card', routeEdges);
cy.on('layoutstop add', routeEdges);

function setEdgeMode(m) {
  edgeMode = m; store.set('edgeMode', m);
  document.querySelectorAll('#edgeModes button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
  cy.style(cyStyle());
  routeEdges();
}
document.querySelectorAll('#edgeModes button').forEach(b => b.onclick = () => setEdgeMode(b.dataset.mode));
setEdgeMode(edgeMode);

/* ----- moving links: dashed links (traffic, dependencies, policies, highlighted ones) run from source to target.
 * Only the dashed links in view are touched, ~30 fps, and only while the graph is on screen; off with the dock button
 * or when the system asks for reduced motion. ----- */
const flow = { on: store.get('graph.flow') !== '0' && !matchMedia('(prefers-reduced-motion: reduce)').matches, off: 0, last: 0, raf: 0, set: null };
const flowEdges = () => cy.edges('[g="traffic"], [g="dep"], [g="policy"], [?via], .lit').filter(e => !e.hasClass('lod'));
cy.on('add remove data class', 'edge', () => { flow.set = null; });
function flowTick(t) {
  flow.raf = 0;
  if (!flow.on) return;
  const graphShown = !document.hidden && !document.querySelector('.app-view:not([hidden])') && $('cy').offsetWidth > 0;
  if (graphShown && t - flow.last > 33) {
    flow.last = t;
    flow.off = (flow.off - 1.2) % 1300; // a common multiple of the dash patterns, so the loop has no visible jump
    if (!flow.set) flow.set = flowEdges();
    const ext = cy.extent();
    const inView = flow.set.filter(e => { const b = e.boundingBox(); return b.x2 > ext.x1 && b.x1 < ext.x2 && b.y2 > ext.y1 && b.y1 < ext.y2; });
    if (inView.length) cy.batch(() => inView.style('line-dash-offset', flow.off));
  }
  flow.raf = requestAnimationFrame(flowTick);
}
function setFlow(on) {
  flow.on = on; store.set('graph.flow', on ? '1' : '0');
  const b = $('flowMode'); if (b) { b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); b.title = on ? 'Tắt chuyển động đường nối' : 'Bật chuyển động đường nối'; }
  const sw = $('flowSw'); if (sw) sw.checked = on;
  if (on && !flow.raf) flow.raf = requestAnimationFrame(flowTick);
  if (!on) cy.batch(() => cy.edges().removeStyle('line-dash-offset'));
}
$('flowMode')?.addEventListener('click', () => setFlow(!flow.on));
setFlow(flow.on);

/* ----- drag mode: off by default (dragging a card pans the canvas); on = cards can be moved and stay put ----- */
let dragMode = false;
cy.autoungrabify(true);
function setDragMode(on) {
  dragMode = on;
  cy.autoungrabify(!on);
  $('dragMode').classList.toggle('on', on);
  $('dragMode').setAttribute('aria-pressed', String(on));
  $('dragMode').title = on ? 'Tắt chế độ kéo thả' : 'Bật chế độ kéo thả thẻ';
  $('dragMode').setAttribute('aria-label', $('dragMode').title);
  $('cy').classList.toggle('drag-mode', on);
}
$('dragMode').onclick = () => setDragMode(!dragMode);
/* with drag mode off, dragging on a card pans the canvas like dragging the background (cytoscape alone would do nothing) */
let nodePan = null;
cy.on('tapstart', 'node', e => {
  if (dragMode) return;
  const oe = e.originalEvent, p = oe && (oe.touches ? oe.touches[0] : oe);
  if (p) nodePan = { x: p.clientX, y: p.clientY };
});
const panMove = (x, y) => {
  if (!nodePan) return;
  cy.panBy({ x: x - nodePan.x, y: y - nodePan.y });
  nodePan = { x, y };
};
addEventListener('mousemove', ev => { if (!(ev.buttons & 1)) nodePan = null; else panMove(ev.clientX, ev.clientY); });
addEventListener('touchmove', ev => { if (ev.touches.length === 1) panMove(ev.touches[0].clientX, ev.touches[0].clientY); }, { passive: true });
addEventListener('mouseup', () => { nodePan = null; });
addEventListener('touchend', () => { nodePan = null; });

/* remember where the user put things (a namespace box moves its cards too) so live updates don't undo it */
cy.on('dragfree', 'node', e => {
  e.target.union(e.target.descendants()).forEach(x => {
    if (x.hasClass('card') || x.hasClass('tile')) state.manual.set(x.id(), { ...x.position() });
  });
});

/* ----- level of detail: far zoomed out, expanded namespaces collapse into a summary ----- */
let lod = false, lodQueued = false;
cy.on('zoom', () => {
  if (lodQueued) return;
  lodQueued = true;
  requestAnimationFrame(() => {
    lodQueued = false;
    const low = cy.zoom() < LOD_ZOOM && cy.nodes('.group').nonempty();
    if (low !== lod) { lod = low; cy.batch(() => cy.elements('.card, .group, edge').toggleClass('lod', low)); }
    if (lod) cy.style().update();
  });
});

/* ================= layouts ================= */
/*
 * Fixed columns by kind, left to right in the direction traffic / ownership flows.
 * A Pod is always in the Pod column, whatever is filtered out.
 */
const COLUMNS = [
  { kinds: ['Gateway'] },                                                                    // Gateway → route → Service
  { kinds: ['Ingress', 'HTTPRoute', 'GRPCRoute', 'TCPRoute', 'TLSRoute', 'UDPRoute', 'IngressRoute', 'IngressRouteTCP', 'IngressRouteUDP',
    'HorizontalPodAutoscaler', 'RoleBinding', 'ClusterRoleBinding', 'MutatingWebhookConfiguration', 'ValidatingWebhookConfiguration',
    'APIService', 'ValidatingAdmissionPolicyBinding'] },
  { kinds: ['Service', 'TraefikService', 'PodDisruptionBudget', 'NetworkPolicy', 'ResourceQuota', 'LimitRange', 'ValidatingAdmissionPolicy'] }, // + custom resources
  { kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'ReplicationController'] },
  { kinds: ['ReplicaSet', 'Job', 'Lease'] },
  { kinds: ['Pod'] },
  { kinds: ['PersistentVolumeClaim', 'ConfigMap', 'Secret', 'ServiceAccount', 'Role', 'ClusterRole', 'Middleware', 'MiddlewareTCP',
    'VolumeAttachment', 'CertificateSigningRequest'] },
  { kinds: ['PersistentVolume', 'StorageClass', 'Node', 'IngressClass', 'GatewayClass', 'PriorityClass', 'RuntimeClass', 'CSIDriver', 'CSINode'] },
];
const COL_OF = {};
COLUMNS.forEach((c, i) => c.kinds.forEach(k => { COL_OF[k] = i; }));
// unknown custom resources sit with the Services (most operators' CRs own or feed workloads)
const colOf = raw => (raw.group && !KNOWN_CR[raw.kind] ? COL_OF.Service : COL_OF[raw.kind] ?? COL_OF.Service);
const KIND_RANK = {};
COLUMNS.flatMap(c => c.kinds).forEach((k, i) => { KIND_RANK[k] = i; });
const COL_GAP = 120, ROW_GAP = 16, COMP_GAP = 44, ISO_ROWS = 6;
const HEALTH_RANK = { error: 0, warn: 1, unknown: 2, ok: 3 };
/*
 * "Weak" relations are drawn but don't shape the layout: infrastructure that many things point at (the Node every pod
 * runs on, a StorageClass, the default ServiceAccount…) would otherwise glue everything into one component and drag
 * nodes apart, leaving big empty gaps.
 */
const WEAK_EDGES = new Set(['runs-on', 'class', 'runs-as', 'pulls', 'subject', 'grants', 'controller', 'priority', 'runtime', 'driver', 'held', 'attaches']);
const SHARED_LIMIT = 2; // a ConfigMap/Secret/PVC used by more pods than this is shared infrastructure too

/*
 * Column layout for a set of cards (+ the edges between them). Returns positions relative to (0,0).
 *  1. connected groups ("components") are laid out one under another, biggest first;
 *  2. inside a component: barycenter sweeps order each column to cut crossings, then each node is pulled
 *     towards the average height of its neighbours (so chains line up horizontally) without overlapping;
 *  3. nodes with no visible edge go in a compact section at the bottom, still under their own column.
 */
function columnLayout(nodes, edges) {
  const info = new Map();
  nodes.forEach(n => info.set(n.id(), { id: n.id(), col: colOf(n.data('raw')), h: n.data('h'), raw: n.data('raw'), nb: [], weak: [] }));
  const indeg = new Map();
  edges.forEach(e => indeg.set(e.target().id(), (indeg.get(e.target().id()) || 0) + 1));
  edges.forEach(e => {
    const a = info.get(e.source().id()), b = info.get(e.target().id());
    if (!a || !b || a === b) return;
    const weak = WEAK_EDGES.has(e.data('type')) || (e.data('type') === 'mounts' && indeg.get(b.id) > SHARED_LIMIT);
    if (weak) { a.weak.push(b); b.weak.push(a); } else { a.nb.push(b); b.nb.push(a); }
  });
  const used = [...new Set([...info.values()].map(i => i.col))].sort((x, y) => x - y);
  const colX = {};
  used.forEach((c, i) => { colX[c] = i * (CARD_W + COL_GAP); });
  const byKindName = (x, y) => (KIND_RANK[x.raw.kind] ?? 99) - (KIND_RANK[y.raw.kind] ?? 99) || x.raw.name.localeCompare(y.raw.name);

  // components
  const seen = new Set(), comps = [], isolated = [], satellites = [];
  for (const it of info.values()) {
    if (seen.has(it.id)) continue;
    seen.add(it.id);
    if (!it.nb.length) { (it.weak.length ? satellites : isolated).push(it); continue; }
    const comp = [], stack = [it];
    while (stack.length) {
      const x = stack.pop(); comp.push(x);
      for (const y of x.nb) if (!seen.has(y.id)) { seen.add(y.id); stack.push(y); }
    }
    comps.push(comp);
  }
  comps.sort((x, y) => y.length - x.length || byKindName([...x].sort(byKindName)[0], [...y].sort(byKindName)[0]));

  const pos = {};
  let yCursor = 0;
  for (const comp of comps) {
    const cols = new Map();
    comp.forEach(n => (cols.get(n.col) || cols.set(n.col, []).get(n.col)).push(n));
    const cs = [...cols.keys()].sort((x, y) => x - y);
    cs.forEach(c => cols.get(c).sort(byKindName).forEach((n, i) => { n.i = i; }));
    // order: barycenter sweeps, alternating direction
    for (let sweep = 0; sweep < 6; sweep++) {
      const fwd = sweep % 2 === 0;
      for (const c of fwd ? cs : [...cs].reverse()) {
        const list = cols.get(c);
        list.forEach(n => {
          const ref = n.nb.filter(m => (fwd ? m.col < c : m.col > c));
          n.bc = ref.length ? ref.reduce((t, m) => t + m.i / Math.max(1, cols.get(m.col).length), 0) / ref.length : n.i / list.length;
        });
        list.sort((x, y) => x.bc - y.bc || x.i - y.i).forEach((n, i) => { n.i = i; });
      }
    }
    // heights: start stacked, then pull towards neighbours, keeping order and spacing
    cs.forEach(c => { let y = 0; for (const n of cols.get(c)) { n.y = y + n.h / 2; y += n.h + ROW_GAP; } });
    for (let it = 0; it < 10; it++) {
      for (const c of it % 2 === 0 ? cs : [...cs].reverse()) {
        const list = cols.get(c);
        const want = list.map(n => {
          const ref = n.nb.filter(m => m.col !== c);
          return ref.length ? ref.reduce((t, m) => t + m.y, 0) / ref.length : n.y;
        });
        let bottom = -Infinity;
        const ys = list.map((n, i) => { const top = Math.max(want[i] - n.h / 2, bottom + ROW_GAP); bottom = top + n.h; return top + n.h / 2; });
        const shift = list.reduce((t, n, i) => t + (want[i] - ys[i]), 0) / list.length;
        list.forEach((n, i) => { n.y = ys[i] + shift; });
      }
    }
    const top = Math.min(...comp.map(n => n.y - n.h / 2)), bot = Math.max(...comp.map(n => n.y + n.h / 2));
    comp.forEach(n => { pos[n.id] = { x: colX[n.col] + CARD_W / 2, y: yCursor + n.y - top }; });
    yCursor += bot - top + COMP_GAP;
  }

  // satellites (only weak relations, e.g. the Node): next to the middle of what they're tied to, without overlapping
  const occupied = new Map(); // col -> [[top, bottom]]
  for (const it of info.values()) {
    const p = pos[it.id];
    if (p) (occupied.get(it.col) || occupied.set(it.col, []).get(it.col)).push([p.y - it.h / 2, p.y + it.h / 2]);
  }
  const median = arr => { const v = [...arr].sort((x, y) => x - y); return v.length ? v[Math.floor((v.length - 1) / 2)] : 0; };
  satellites.forEach(n => { n.want = median(n.weak.map(m => pos[m.id]?.y).filter(y => y != null)); });
  satellites.sort((x, y) => x.col - y.col || x.want - y.want);
  let bottomAll = yCursor - (comps.length ? COMP_GAP : 0);
  for (const n of satellites) {
    const occ = occupied.get(n.col) || occupied.set(n.col, []).get(n.col);
    let top = Math.max(0, n.want - n.h / 2);
    for (let moved = true; moved;) { // slide down until it fits between the cards already in this column
      moved = false;
      for (const [t, b] of occ) if (top < b + ROW_GAP && top + n.h > t - ROW_GAP) { top = b + ROW_GAP; moved = true; }
    }
    occ.push([top, top + n.h]);
    pos[n.id] = { x: colX[n.col] + CARD_W / 2, y: top + n.h / 2 };
    bottomAll = Math.max(bottomAll, top + n.h);
  }
  if (satellites.length) yCursor = bottomAll + COMP_GAP;

  // isolated cards: compact grid per column, problems first
  let isoHeaderY = null;
  if (isolated.length) {
    if (comps.length || satellites.length) { isoHeaderY = yCursor + 6; yCursor += 40; }
    const groups = new Map();
    isolated.forEach(n => (groups.get(n.col) || groups.set(n.col, []).get(n.col)).push(n));
    let xCursor = 0, maxH = 0;
    for (const c of [...groups.keys()].sort((x, y) => x - y)) {
      const list = groups.get(c).sort((x, y) => (HEALTH_RANK[x.raw.health] ?? 2) - (HEALTH_RANK[y.raw.health] ?? 2) || byKindName(x, y));
      const sub = Math.ceil(list.length / ISO_ROWS), x0 = Math.max(colX[c], xCursor);
      for (let k = 0; k < sub; k++) {
        let y = 0;
        for (const n of list.slice(k * ISO_ROWS, (k + 1) * ISO_ROWS)) {
          pos[n.id] = { x: x0 + k * (CARD_W + 24) + CARD_W / 2, y: yCursor + y + n.h / 2 };
          y += n.h + ROW_GAP;
        }
        maxH = Math.max(maxH, y);
      }
      xCursor = x0 + sub * (CARD_W + 24) + COL_GAP - 24;
    }
    yCursor += maxH;
  }
  const width = Math.max(0, ...Object.values(pos).map(p => p.x + CARD_W / 2));
  return { pos, colX, used, isoHeaderY, isoCount: isolated.length, width, height: Math.max(0, yCursor - (isolated.length ? 0 : COMP_GAP)) };
}

/* header label of a column: the kinds actually present in it */
function columnTitle(col, nodes) {
  const labels = [...new Set(nodes.filter(n => colOf(n.data('raw')) === col).map(n => kindInfo(n.data('raw')).label))];
  return labels.length > 3 ? labels.slice(0, 3).join(' · ') + ' …' : labels.join(' · ');
}

function layout(animate, fit) {
  return isAll() ? groupedLayout(animate, fit) : flatLayout(animate, fit);
}

function flatLayout(animate, fit) {
  const cards = cy.nodes('.card');
  const L = columnLayout(cards, cy.edges());
  // column titles + "no visible relations" title are plain label nodes, rebuilt with every layout
  cy.remove('.colhead, .isohead');
  const heads = L.used.map(c => ({ group: 'nodes', classes: 'colhead', selectable: false, grabbable: false,
    data: { id: 'colhead:' + c, label: columnTitle(c, cards) }, position: { x: L.colX[c] + CARD_W / 2, y: -38 } }));
  if (L.isoHeaderY != null)
    heads.push({ group: 'nodes', classes: 'isohead', selectable: false, grabbable: false,
      data: { id: 'isohead', label: `Không có quan hệ đang hiển thị · ${L.isoCount}` }, position: { x: 0, y: L.isoHeaderY } });
  cy.add(heads);
  return cy.layout({ name: 'preset', positions: n => state.manual.get(n.id()) || L.pos[n.id()] || n.position(), animate, animationDuration: 350,
    animationEasing: 'ease-out-cubic', fit, padding: 40,
    stop: () => {
      if (!fit) return;
      if (cy.zoom() > 1.1) { cy.zoom(1.1); cy.center(); }
      else if (cy.zoom() < MIN_READABLE_ZOOM) { // too big to fit legibly: start readable at the top-left, user pans from there
        const bb = cy.elements().boundingBox();
        cy.zoom(MIN_READABLE_ZOOM);
        cy.pan({ x: 40 - bb.x1 * MIN_READABLE_ZOOM, y: 40 - bb.y1 * MIN_READABLE_ZOOM });
      }
    },
  }).run();
}

/*
 * All-namespaces view.
 * Expanded namespaces: column layout each on its own, then masonry-pack the boxes (best zoom wins).
 * Collapsed namespaces: summary tiles in a grid below — app namespaces first, then a "system" section.
 */
function groupedLayout(animate, fit) {
  const PAD = 26, GAP_X = 70, GAP_Y = 110, TGX = 24, TGY = 24;
  const positions = {};
  const boxes = cy.nodes('.group').map(g => {
    const kids = g.children('.card');
    const inner = kids.connectedEdges().filter(e => e.source().parent().same(g) && e.target().parent().same(g));
    const L = columnLayout(kids, inner);
    return { ns: g.data('ns'), order: g.data('order'), pos: L.pos, w: L.width + PAD * 2, h: L.height + PAD * 2 };
  });

  const vw = Math.max(1, cy.width() - 100), vh = Math.max(1, cy.height() - 100);
  let zoneW = 0, zoneH = 0;
  if (boxes.length) {
    // masonry: try 1..n columns, biggest boxes first into the shortest column; keep the best-fitting column count
    const order = [...boxes].sort((a, b) => b.h * b.w - a.h * a.w || a.order - b.order);
    let best = null;
    for (let k = 1; k <= order.length; k++) {
      const cols = Array.from({ length: k }, () => ({ h: 0, w: 0, items: [] }));
      order.forEach(b => {
        const c = cols.reduce((m, c) => (c.h < m.h ? c : m), cols[0]);
        c.items.push({ b, y: c.h }); c.h += b.h + GAP_Y; c.w = Math.max(c.w, b.w);
      });
      const used = cols.filter(c => c.items.length);
      const W = used.reduce((s, c) => s + c.w, 0) + GAP_X * (used.length - 1);
      const Hh = Math.max(...used.map(c => c.h - GAP_Y));
      const zoom = Math.min(vw / W, vh / Hh);
      if (!best || zoom > best.zoom + 1e-6) best = { zoom, cols: used, W, H: Hh };
    }
    let x = 0;
    best.cols.forEach(c => {
      c.items.forEach(({ b, y }) => Object.entries(b.pos).forEach(([id, p]) => positions[id] = { x: x + PAD + p.x, y: y + PAD + p.y }));
      x += c.w + GAP_X;
    });
    zoneW = best.W; zoneH = best.H;
  }

  const tiles = cy.nodes('.tile').sort((a, b) => a.data('order') - b.data('order'));
  const app = tiles.filter(t => !t.data('system')), sys = tiles.filter(t => t.data('system'));
  if (tiles.nonempty()) {
    const aspect = vw / vh;
    let cols = Math.max(1, Math.round(Math.sqrt(tiles.length * aspect * (TILE_H + TGY) / (TILE_W + TGX))));
    if (boxes.length) cols = Math.max(cols, Math.floor((zoneW + TGX) / (TILE_W + TGX)));
    cols = Math.max(1, Math.min(cols, Math.max(app.length, sys.length)));
    let y = boxes.length ? zoneH + GAP_Y : 0;
    const place = list => {
      list.forEach((t, i) => {
        const c = i % cols, r = Math.floor(i / cols);
        positions[t.id()] = { x: c * (TILE_W + TGX) + TILE_W / 2, y: y + r * (TILE_H + TGY) + TILE_H / 2 };
      });
      if (list.length) y += Math.ceil(list.length / cols) * (TILE_H + TGY);
    };
    place(app);
    const section = cy.getElementById('section:system');
    if (sys.nonempty()) {
      y += app.nonempty() ? 26 : 0;
      if (section.nonempty()) { positions[section.id()] = { x: 0, y: y + 8 }; section.position(positions[section.id()]); }
      y += 32;
      place(sys);
    }
  }
  const focus = state.focusNs;
  state.focusNs = null;
  return cy.layout({ name: 'preset', positions: n => state.manual.get(n.id()) || positions[n.id()], animate, animationDuration: 350,
    animationEasing: 'ease-out-cubic', fit: fit && !focus, padding: 50,
    stop: () => {
      if (!focus) return;
      const g = cy.getElementById('ns:' + focus);
      if (g.nonempty()) cy.animate({ fit: { eles: g, padding: 60 }, duration: 400, easing: 'ease-out-cubic' });
    },
  }).run();
}

/* ================= model helpers ================= */
/* in the all-namespaces view a cluster-scoped object (PV, StorageClass…) goes into the one namespace it's tied to, if any */
function placement(g) {
  const nsOf = new Map(g.nodes.map(n => [n.id, n.namespace]));
  const linked = new Map();
  g.edges.forEach(e => {
    for (const [a, b] of [[e.source, e.target], [e.target, e.source]]) {
      if (nsOf.get(a)) continue;
      const other = nsOf.get(b);
      if (!other) continue;
      (linked.get(a) || linked.set(a, new Set()).get(a)).add(other);
    }
  });
  const out = new Map();
  g.nodes.forEach(n => {
    if (n.namespace) return out.set(n.id, n.namespace);
    const s = linked.get(n.id);
    out.set(n.id, s && s.size === 1 ? [...s][0] : CLUSTER);
  });
  return out;
}

const WORKLOADS = ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'];
function summarize(nodes, ns) {
  const s = { ns, label: ns === CLUSTER ? 'cluster-scoped' : ns, system: isSystemNs(ns), total: nodes.length,
    err: 0, warn: 0, ok: 0, podOk: 0, podWarn: 0, podErr: 0, workloads: 0, pods: 0, services: 0 };
  const byKind = {};
  nodes.forEach(n => {
    byKind[n.kind] = (byKind[n.kind] || 0) + 1;
    if (n.health === 'error') s.err++; else if (n.health === 'warn') s.warn++; else if (n.health === 'ok') s.ok++;
    if (WORKLOADS.includes(n.kind)) s.workloads++;
    if (n.kind === 'Service') s.services++;
    if (n.kind === 'Pod') { s.pods++; if (n.health === 'error') s.podErr++; else if (n.health === 'warn') s.podWarn++; else s.podOk++; }
  });
  s.line = ns === CLUSTER
    ? Object.entries(byKind).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, c]) => `${c} ${(KINDS[k] || { label: k }).label}`).join(' · ')
    : `${s.workloads} workload · ${s.pods} pod · ${s.services} service`;
  s.lodLabel = `${s.label}\n${s.pods} pod · ${s.err} lỗi · ${s.warn} cảnh báo`;
  s.hcolor = s.err ? css('--error') : s.warn ? css('--warn') : css('--ok');
  return s;
}

/* order: namespaces with errors, then warnings, then the rest — app namespaces before system ones */
function nsOrder(summaries) {
  return [...summaries].sort((a, b) => (a.ns === CLUSTER) - (b.ns === CLUSTER) || a.system - b.system
    || (b.err > 0) - (a.err > 0) || (b.warn > 0) - (a.warn > 0) || a.label.localeCompare(b.label));
}

/*
 * Ownership through filtered-out kinds: with ReplicaSet hidden, Deployment → Pod is drawn directly ("via" edge).
 * If every owner up the chain is hidden, the card gets a note naming the top-level owner (e.g. "deploy web").
 */
function ownership(g, visible) {
  const owners = new Map();
  g.edges.forEach(e => { if (e.type === 'owns') (owners.get(e.target) || owners.set(e.target, []).get(e.target)).push(e.source); });
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  const via = [], notes = new Map();
  for (const id of visible) {
    const direct = owners.get(id) || [];
    if (!direct.length || direct.some(o => visible.has(o))) continue;
    let frontier = direct, seen = new Set(), found = false, root = null;
    while (frontier.length && !found) {
      const next = [];
      for (const o of frontier) {
        if (seen.has(o)) continue;
        seen.add(o);
        if (visible.has(o)) { via.push({ source: o, target: id, type: 'owns', via: true }); found = true; }
        else { const up = owners.get(o) || []; if (!up.length) root = o; next.push(...up); }
      }
      frontier = next;
    }
    if (!found && root && byId.get(root)) {
      const r = byId.get(root), chip = CHIPS.find(c => c.id === r.kind);
      notes.set(id, `${chip?.short || r.kind.toLowerCase()} ${r.name}`);
    }
  }
  return { via, notes };
}

/* IngressClass filtered out: draw Ingress → its controller directly, so the controller card isn't left dangling */
function controllerVia(g, visible) {
  const out = [];
  g.edges.filter(e => e.type === 'controller' && !visible.has(e.source) && visible.has(e.target)).forEach(c => {
    g.edges.filter(e => e.type === 'class' && e.target === c.source && visible.has(e.source))
      .forEach(e => out.push({ source: e.source, target: c.target, type: 'controller', via: true }));
  });
  return out;
}

/* ================= rendering ================= */
/* big workloads on the map: the pods of one controller (ReplicaSet, StatefulSet, DaemonSet, Job) beyond POD_GROUP_MIN
 * become one card "api · 400 pod" with their states counted; a tap on it opens them up (state.podGroupsOpen) */
const POD_GROUP_MIN = 6;
state.podGroupsOpen = new Set();
function simplifyGraph(g) {
  const pods = new Map(g.nodes.filter(n => n.kind === 'Pod').map(n => [n.id, n]));
  if (pods.size < POD_GROUP_MIN) return g;
  const byOwner = new Map();
  g.edges.forEach(e => { if (e.type === 'owns' && pods.has(e.target)) (byOwner.get(e.source) || byOwner.set(e.source, []).get(e.source)).push(e.target); });
  const to = new Map(), extra = [];
  const byId = new Map(g.nodes.map(n => [n.id, n]));
  byOwner.forEach((ids, owner) => {
    if (ids.length < POD_GROUP_MIN || state.podGroupsOpen.has(owner)) return;
    const o = byId.get(owner) || { name: owner.split('/').pop(), namespace: pods.get(ids[0]).namespace };
    const list = ids.map(id => pods.get(id)), by = {};
    list.forEach(p => { const st = p.status || '?'; by[st] = (by[st] || 0) + 1; });
    const health = list.some(p => p.health === 'error') ? 'error' : list.some(p => p.health === 'warn') ? 'warn' : list.every(p => p.health === 'unknown') ? 'unknown' : 'ok';
    const states = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const id = 'pg:' + owner;
    extra.push({ id, kind: 'Pod', group: null, name: `${ids.length} pod · ${o.name}`, namespace: o.namespace,
      status: states.slice(0, 2).map(([k, v]) => `${v} ${k}`).join(' · ') + (states.length > 2 ? ' …' : ''), health,
      reason: health !== 'ok' ? `${list.filter(p => p.health === health).length}/${ids.length} pod ${health === 'error' ? 'lỗi' : 'cảnh báo'}` : null,
      missing: false, labels: {}, created: list.map(p => p.created).filter(Boolean).sort().pop() || null,
      info: { pods: String(ids.length) }, // a fixed shape: state counts live in the status line, so the card keeps its height
      podGroup: owner, podIds: ids });
    ids.forEach(p => to.set(p, id));
  });
  if (!extra.length) return g;
  const nodes = g.nodes.filter(n => !to.has(n.id)).concat(extra);
  const seen = new Set(), edges = [];
  g.edges.forEach(e => {
    const s = to.get(e.source) || e.source, t = to.get(e.target) || e.target;
    if (s === t) return;
    const k = s + '>' + t + '>' + e.type;
    if (seen.has(k)) return; seen.add(k);
    edges.push(s === e.source && t === e.target ? e : { ...e, source: s, target: t });
  });
  return { ...g, nodes, edges };
}

function render(fitView) {
  if (!state.graph) return;
  // the relationship map is only built while it is on screen; other views just keep counts and the panel current
  if (document.querySelector('.app-view:not([hidden])')) {
    $('loading').style.display = 'none';
    state.graphStale = true; state.graphFit = state.graphFit || !!fitView;
    updateCounts(); refreshPanel();
    return;
  }
  if (state.graphStale) { state.graphStale = false; fitView = fitView || state.graphFit; state.graphFit = false; state.structureKey = ''; }
  const g = simplifyGraph(state.graph);
  // a live update while the user is holding a card would re-layout under their mouse: wait until it's dropped
  if (cy.$('node:grabbed').nonempty()) {
    clearTimeout(state.deferredRender);
    state.deferredRender = setTimeout(() => render(fitView), 250);
    return;
  }
  $('loading').style.display = 'none';
  const all = isAll();
  $('nsbar').hidden = !all;
  const shown = g.nodes.filter(isVisible);
  let cards, tiles = [], groups = [];

  if (all) {
    const place = placement(g), full = state.graph, placeFull = full === g ? place : placement(full);
    // namespace tiles count the real objects (every pod), not the grouped cards
    const byNs = new Map();
    full.nodes.forEach(n => { const k = placeFull.get(n.id); (byNs.get(k) || byNs.set(k, []).get(k)).push(n); });
    const sums = nsOrder([...byNs].map(([ns, list]) => summarize(list, ns)));
    sums.forEach((s, i) => {
      s.order = i;
      if (state.expanded.has(s.ns)) groups.push(s); else tiles.push(s);
    });
    const expandedNs = new Set(groups.map(s => s.ns));
    cards = shown.filter(n => expandedNs.has(place.get(n.id))).map(n => ({ n, parent: 'ns:' + place.get(n.id) }));
    // an expanded namespace whose kinds are all filtered out falls back to its tile
    const empty = groups.filter(s => !cards.some(c => c.parent === 'ns:' + s.ns));
    groups = groups.filter(s => !empty.includes(s));
    tiles = [...tiles, ...empty].sort((a, b) => a.order - b.order);
    groups.forEach(s => { s.count = cards.filter(c => c.parent === 'ns:' + s.ns).length; });
  } else {
    cards = shown.map(n => ({ n }));
  }
  const ids = new Set(cards.map(c => c.n.id));
  const missing = new Set(g.nodes.filter(n => n.missing).map(n => n.id));
  const own = ownership(g, ids);
  // a card from another namespace in a one-namespace view (the ingress controller in kube-system…) says where it lives
  if (!all) own.notes = new Map([...cards.filter(c => c.n.namespace && c.n.namespace !== currentNs()).map(c => [c.n.id, 'ns ' + c.n.namespace]), ...own.notes]);
  cards = cards.map(c => (own.notes.has(c.n.id) ? { ...c, n: { ...c.n, note: own.notes.get(c.n.id) } } : c));
  const edges = [...g.edges.filter(e => ids.has(e.source) && ids.has(e.target)), ...own.via, ...controllerVia(g, ids)];
  const key = (all ? 'A' : 'N') + [...ids].join('|') + '#' + edges.map(e => e.source + '>' + e.target + e.type + (e.via ? '~' : '')).join('|')
    + '#' + tiles.map(t => t.ns).join(',') + '#' + groups.map(s => s.ns).join(',')
    + '#' + cards.map(c => c.n.id + ':' + cardH(c.n)).join(',');

  if (key === state.structureKey && !fitView) {
    cards.forEach(({ n }) => {
      const el = cy.getElementById(n.id);
      if (JSON.stringify(el.data('raw')) !== JSON.stringify(n)) el.data({ raw: n, img: cardImage(n), imgH: cardImage(n, true), imgS: cardImage(n, false, true) });
    });
    tiles.forEach(s => {
      const el = cy.getElementById('tile:' + s.ns);
      if (JSON.stringify(el.data('summary')) !== JSON.stringify(s)) el.data({ summary: s, img: tileImage(s), imgH: tileImage(s, true) });
    });
    groups.forEach(s => cy.getElementById('ns:' + s.ns).data({ label: `${s.label}  ·  ${s.count}`, lodLabel: s.lodLabel, hcolor: s.hcolor }));
  } else {
    const prev = new Map(cy.nodes('.card, .tile').map(n => [n.id(), n.position()]));
    state.structureKey = key;
    cy.batch(() => {
      cy.elements().remove();
      cy.add(groups.map(s => ({ group: 'nodes', classes: 'group' + (s.system ? ' system' : ''), selectable: false,
        data: { id: 'ns:' + s.ns, ns: s.ns, order: s.order, label: `${s.label}  ·  ${s.count}`, lodLabel: s.lodLabel, hcolor: s.hcolor } })));
      cy.add(tiles.map(s => ({ group: 'nodes', classes: 'tile', selectable: false, position: prev.get('tile:' + s.ns),
        data: { id: 'tile:' + s.ns, ns: s.ns, order: s.order, system: s.system, summary: s, img: tileImage(s), imgH: tileImage(s, true) } })));
      if (tiles.some(s => s.system))
        cy.add({ group: 'nodes', classes: 'section', selectable: false, data: { id: 'section:system', label: 'Namespace hệ thống' } });
      cy.add(cards.map(({ n, parent }) => ({ group: 'nodes', classes: 'card', position: prev.get(n.id),
        data: { id: n.id, raw: n, img: cardImage(n), imgH: cardImage(n, true), imgS: cardImage(n, false, true), h: cardH(n), parent } })));
      cy.add(edges.map((e, i) => ({ group: 'edges',
        data: { id: 'e' + i, source: e.source, target: e.target, type: e.type, g: EDGE_GROUP[e.type] || 'dep', broken: missing.has(e.target), via: !!e.via } })));
      if (lod) cy.elements('.card, .group, edge').addClass('lod');
    });
    layout(!fitView && prev.size > 0, fitView || (all && prev.size === 0));
    if (state.selected && cy.getElementById(state.selected).nonempty()) cy.getElementById(state.selected).select();
  }
  try { // big graph: draw a cached bitmap / skip edges while panning & zooming
    const big = cy.elements().length > 350, r = cy.renderer();
    r.textureOnViewport = big; r.hideEdgesOnViewport = big;
  } catch {}
  updateCounts();
  applyFocus();
  refreshPanel();
  if (!cards.length && !tiles.length) showEmpty();
}

function showEmpty() {
  $('loading').style.display = '';
  $('loading').innerHTML = `<div class="box">${icon('Pod')}<div>Không có tài nguyên nào để hiển thị</div>
    <div class="muted" style="font-size:12px">Thử chọn namespace khác hoặc bật thêm loại tài nguyên ở thanh lọc.</div></div>`;
}

function updateCounts() {
  const g = state.graph, counts = {};
  const foreign = n => !isAll() && n.namespace && n.namespace !== currentNs(); // e.g. the ingress controller from kube-system
  g.nodes.forEach(n => {
    if (n.missing || foreign(n) || (n.kind === 'Node' && !nodeCardWanted(n))) return;
    const c = chipOf(n); counts[c] = (counts[c] || 0) + 1;
  });
  state.kindCounts = counts;
  if (typeof renderFilters === 'function') renderFilters();
  const vis = g.nodes.filter(isVisible).filter(n => n.health !== 'unknown');
  const by = h => vis.filter(n => n.health === h).length;
  $('cErr').textContent = by('error'); $('cWarn').textContent = by('warn'); $('cOk').textContent = by('ok');
  document.querySelectorAll('.hchip[data-h]').forEach(b => {
    const n = by(b.dataset.h); b.disabled = n === 0;
    if (n === 0 && state.health === b.dataset.h) state.health = null;
    b.classList.toggle('active', state.health === b.dataset.h);
  });
}

function matchesQuery(n, q) {
  if (!q) return true;
  return n.name.toLowerCase().includes(q) || n.kind.toLowerCase().includes(q) || (n.namespace || '').toLowerCase().includes(q)
    || Object.values(n.labels || {}).some(v => String(v).toLowerCase().includes(q));
}

/* search / health filter dim everything else; hover only lights up the hovered node's edges and neighbours */
function applyFocus() {
  cy.batch(() => {
    cy.elements().removeClass('faded lit');
    if (state.hovered) {
      const h = cy.getElementById(state.hovered);
      if (h.nonempty()) h.connectedEdges().addClass('lit');
    }
    const q = state.query.toLowerCase();
    const onNode = state.nodeFocus ? podsOnNode(state.nodeFocus) : null;
    if (!q && !state.health && !onNode) return;
    const hit = n => matchesQuery(n, q) && (!state.health || n.health === state.health) && (!onNode || onNode.has(n.id));
    const focus = cy.nodes('.card').filter(n => hit(n.data('raw')));
    // collapsed namespaces: keep the tile if anything inside matches
    const place = isAll() ? placement(state.graph) : null;
    const tileHits = new Set();
    if (place) state.graph.nodes.filter(isVisible).filter(hit).forEach(n => tileHits.add('tile:' + place.get(n.id)));
    // node filter: also keep what leads to those pods (Ingress → Service → Pod, HPA → Deployment → ReplicaSet → Pod…)
    const chain = onNode ? upstreamOf(new Set(state.graph.nodes.filter(hit).map(n => n.id))) : null;
    if (chain && place) state.graph.nodes.filter(isVisible).filter(n => chain.has(n.id)).forEach(n => tileHits.add('tile:' + place.get(n.id)));
    const chainCards = chain ? cy.nodes('.card').filter(n => chain.has(n.id())) : cy.collection();
    const keep = focus.union(focus.neighborhood()).union(focus.ancestors()).union(chainCards).union(chainCards.ancestors()).union(cy.$('node:selected'))
      .union(cy.nodes('.tile').filter(t => tileHits.has(t.id())));
    cy.elements().not(keep).not('.group, .section, .colhead, .isohead').addClass('faded');
    focus.connectedEdges().addClass('lit');
    if (chain) chainCards.edgesWith(chainCards.union(focus)).addClass('lit');
  });
}

/* everything that routes to / owns / scales / protects the given ids, transitively (edges walked target → source) */
const UPSTREAM_EDGES = new Set(['owns', 'selects', 'routes', 'scales', 'protects', 'applies', 'controller', 'class']);
function upstreamOf(ids) {
  const into = new Map();
  state.graph.edges.forEach(e => { if (UPSTREAM_EDGES.has(e.type)) (into.get(e.target) || into.set(e.target, []).get(e.target)).push(e.source); });
  const seen = new Set(ids), todo = [...ids];
  while (todo.length) for (const src of into.get(todo.pop()) || []) if (!seen.has(src)) { seen.add(src); todo.push(src); }
  return seen;
}

/* ================= detail panel ================= */
function setPanel(open) {
  if ($('main').classList.contains('no-panel') !== open) return;
  $('main').classList.toggle('no-panel', !open);
  setTimeout(() => {
    cy.resize(); // after the grid transition
    const sel = cy.$('node.card:selected');
    if (open && sel.nonempty()) {
      const bb = sel.renderedBoundingBox();
      if (bb.x2 > cy.width() - 20 || bb.x1 < 0) cy.animate({ center: { eles: sel }, duration: 250, easing: 'ease-out-cubic' });
    }
  }, 240);
}

function clearDetail(keepOpen) {
  state.selected = null; state.panelNs = null;
  delete $('detail').dataset.id;
  if (!keepOpen) setPanel(false);
  $('detail').innerHTML = `<div class="d-empty">
    <svg class="i" viewBox="0 0 24 24"><path d="M4 4l7 17 2.5-7.5L21 11z"/></svg>
    <div>Chọn một tài nguyên trên sơ đồ để xem chi tiết</div>
    <div class="hint">Rê chuột để làm nổi bật các quan hệ<br>Cuộn để zoom · kéo nền để di chuyển<br>
    Ở "Tất cả namespace": bấm ô để mở rộng, nhấp đúp khung để mở riêng<br><kbd>/</kbd> tìm kiếm · <kbd>Esc</kbd> bỏ chọn</div></div>`;
}

function refreshPanel() {
  if (state.selected) {
    const el = cy.getElementById(state.selected);
    if (el.nonempty()) showDetail(el, true);
    else {
      const n = state.graph.nodes.find(x => x.id === state.selected);
      n ? showDetailRaw(n, true) : clearDetail();
    }
  } else if (state.panelNs) showNsPanel(state.panelNs);
}

const hvar = h => `var(--${H(h)})`;
function sec(title, body, extra = '') { return body ? `<section ${extra}><h3>${title}</h3>${body}</section>` : ''; }
function dl(entries) {
  return entries.length ? `<dl>${entries.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';
}

function showDetail(node, refresh) { showDetailRaw(node.data('raw'), refresh); }

/*
 * Detail panel, ArgoCD style: a fixed header (identity, status pills, action toolbar) and tabs
 * (Tổng quan / Events / YAML / Quan hệ). Live updates only replace the parts whose HTML changed,
 * so scroll position, the YAML viewer and anything being typed survive.
 */
const TABS = [['overview', 'Tổng quan'], ['events', 'Events'], ['relations', 'Quan hệ'], ['history', 'Lịch sử'], ['yaml', 'YAML'], ['describe', 'Describe']];
const HISTORY_KINDS = ['Deployment', 'StatefulSet', 'DaemonSet'];
const tabAvailable = (n, t) => !(n.missing && ['yaml', 'events', 'history', 'describe'].includes(t)) && (t !== 'history' || HISTORY_KINDS.includes(n.kind));
state.tab = store.get('tab') || 'overview';
state.condOpen = store.get('condOpen') === '1';

function relationsOf(n) {
  const groups = {}, byId = new Map(state.graph.nodes.map(x => [x.id, x]));
  state.graph.edges.forEach(e => {
    const out = e.source === n.id, inn = e.target === n.id;
    if (!out && !inn) return;
    const other = byId.get(out ? e.target : e.source);
    if (!other) return;
    const title = (REL[e.type] || [e.type, e.type])[out ? 0 : 1];
    (groups[title] ||= []).push(other);
  });
  return groups;
}

function showDetailRaw(n, refresh) {
  const sameNode = state.selected === n.id && $('detail').dataset.id === n.id;
  state.selected = n.id; state.panelNs = null;
  setPanel(true);
  const d = state.details.id === n.id ? state.details.data : null;
  const rels = relationsOf(n);
  const relCount = Object.values(rels).reduce((t, l) => t + l.length, 0);
  const evCount = d && d.events ? d.events.length : null;
  const warnEv = d && d.events ? d.events.filter(e => e.type === 'Warning').length : 0;

  if (!(refresh && sameNode)) {
    $('detail').dataset.id = n.id;
    $('detail').innerHTML = `<div class="dp">
      <div class="dp-resize" id="dpResize" role="separator" aria-orientation="vertical" aria-label="Độ rộng panel" tabindex="0" title="Kéo để đổi độ rộng · nhấp đúp: mặc định · kéo hết sang phải: đóng"></div>
      <header class="dp-head" id="dpHead"></header>
      <nav class="dp-tabs" id="dpTabs" role="tablist"></nav>
      <div class="dp-body" id="dpBody"></div></div>`;
    $('dpBody').dataset.key = '';
  }
  patch('dpHead', panelHeader(n, d));
  patch('dpTabs', TABS.filter(([t]) => tabAvailable(n, t)).map(([t, label]) => {
    const count = t === 'events' ? evCount : t === 'relations' ? relCount : null;
    return `<button role="tab" class="dp-tab ${state.tab === t ? 'on' : ''}" data-tab="${t}" aria-selected="${state.tab === t}">${label}${count != null ? `<span class="cnt ${t === 'events' && warnEv ? 'warn' : ''}">${count}</span>` : ''}</button>`;
  }).join(''));
  const tabsEl = $('dpTabs'); tabsEl.classList.toggle('ovf', tabsEl.scrollWidth > tabsEl.clientWidth + 2 && tabsEl.scrollLeft + tabsEl.clientWidth < tabsEl.scrollWidth - 2);
  const tab = tabAvailable(n, state.tab) ? state.tab : 'overview';
  if (tab === 'yaml') renderYamlTab(n, refresh && sameNode);
  else if (tab === 'history') renderHistoryTab(n, refresh && sameNode);
  else if (tab === 'describe') renderDescribeTab(n, refresh && sameNode);
  else patch('dpBody', tab === 'events' ? eventsTab(d) : tab === 'relations' ? relationsTab(n, rels) : overviewTab(n, d));
  const el = cy.getElementById(n.id);
  if (el.nonempty() && !el.selected()) { cy.$(':selected').unselect(); el.select(); }
  if (!n.missing) loadDetails(n);
}

/* replace a region only when its HTML actually changed (keeps focus / scroll / inputs otherwise) */
function patch(id, html) {
  const el = $(id);
  if (el && el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

/* ---------- header: identity · status line · owner · toolbar ---------- */
const svgI = p => `<svg class="i" viewBox="0 0 24 24">${p}</svg>`;
function findNode(kind, ns, name) {
  return state.graph.nodes.find(x => x.kind === kind && x.name === name && (!ns || !x.namespace || x.namespace === ns));
}
function ownerLine(n, d) {
  const m = d && d.manager;
  if (m && m.tool === 'controller') {
    const [kind, name] = String(m.name).includes('/') ? m.name.split('/') : ['', m.name];
    const o = kind && findNode(kind, n.namespace, name);
    const label = `<span class="k">${esc(kind)}</span> ${esc(name)}`;
    return `<div class="dp-owner" title="${esc(m.note || '')}">${svgI('<path d="M9 14l-5-5 5-5M4 9h11a5 5 0 0 1 0 10h-3"/>')}Quản lý bởi
      ${o ? `<a data-goto="${esc(o.id)}">${label}</a>` : `<span>${label}</span>`}</div>`;
  }
  const chips = [];
  // Helm only re-applies on the next upgrade (informational); Argo CD / Flux may overwrite edits (warning, or error when it self-heals)
  if (m && m.tool === 'Helm') chips.push(`<span class="pill helm" title="${esc(m.note)}">${svgI('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4v5.5M12 14.5V20M4 12h5.5M14.5 12H20"/>')}Helm · ${esc(m.name)}</span>`);
  else if (m) chips.push(`<span class="pill mgr ${m.revertsQuickly ? 'hot' : ''}" title="${esc(m.note)}">${svgI('<path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>')}${esc(m.tool)} · ${esc(m.name)}</span>`);
  else if (d && d.helm) chips.push(`<span class="pill helm" title="Helm release">${svgI('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2.5"/><path d="M12 4v5.5M12 14.5V20M4 12h5.5M14.5 12H20"/>')}Helm · ${esc(d.helm.release || '')}${d.helm.chart ? ` · ${esc(d.helm.chart)}` : ''}</span>`);
  return chips.length ? `<div class="dp-pills">${chips.join('')}</div>` : '';
}

function panelHeader(n, d) {
  const k = kindInfo(n), a = age(n.created);
  const tools = typeof actionTools === 'function' ? actionTools(n) : { main: '', more: '', danger: '' };
  const logs = typeof podsFor === 'function' && podsFor(n.id).length
    ? `<button class="tool" id="openLogs">${svgI('<path d="M4 17l6-6-6-6M12 19h8"/>')}Log</button>` : '';
  const more = tools.more ? `<div class="dp-more-wrap"><button class="tool icon" data-more aria-expanded="${state.moreOpen === n.id}" title="Thêm hành động">${svgI('<circle cx="5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="19" cy="12" r="1.3"/>')}</button>
    ${state.moreOpen === n.id ? `<div class="dp-menu" role="menu">${tools.more}</div>` : ''}</div>` : '';
  const bar = logs + tools.main + more;
  return `
    <div class="dp-top">
      <div class="tile" style="--c:${n.missing ? 'var(--error)' : k.color}">${icon(iconKind(n))}</div>
      <div class="dp-id">
        <div class="dp-kind">${esc(n.kind)}${n.group ? `<span class="grp">${esc(n.group)}</span>` : ''}<span class="ns">${n.namespace ? svgI('<path d="M3 7l9-4 9 4-9 4z M3 12l9 4 9-4M3 17l9 4 9-4"/>') + esc(n.namespace) : 'cluster-scoped'}</span></div>
        <h2 title="${esc(n.name)}">${esc(n.name)}<button class="copy" data-copyname="${esc(n.name)}" title="Sao chép tên">${svgI('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>')}</button></h2>
      </div>
      <button class="icon-btn sm" id="dpMode" title="${panelModeTitle()}" aria-pressed="${panelMode() === 'overlay'}">${svgI(panelModeIcon())}</button>
      <button class="icon-btn sm" id="dpWide" title="${panelIsWide() ? 'Thu hẹp panel' : 'Mở rộng panel'}" aria-pressed="${panelIsWide()}">${svgI(panelIsWide()
        ? '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>' : '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>')}</button>
      <button class="icon-btn sm" id="dclose" title="Đóng (Esc)">${svgI('<path d="M6 6l12 12M18 6L6 18"/>')}</button>
    </div>
    <div class="dp-status">
      <span class="pill h" style="--c:${hvar(n.health)}"><i></i>${esc(n.status || n.health)}</span>
      ${a ? `<span class="meta" title="Tạo lúc ${esc(fmtTime(n.created))}">${svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}${a}</span>` : ''}
    </div>
    ${ownerLine(n, d)}
    ${bar.trim() || tools.danger ? `<div class="dp-tools">${bar}</div>` : ''}
    ${typeof actionExtras === 'function' ? actionExtras(n) : ''}`;
}

const fmtTime = ts => { const t = new Date(ts); return isNaN(t) ? String(ts ?? '') : t.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'medium' }); };

function reasonBox(n) {
  if (!n.reason && !n.missing) return '';
  const title = n.missing ? 'Tham chiếu bị gãy' : (n.status && n.status !== n.reason ? n.status : 'Lý do');
  return `<div class="reason" style="--c:${hvar(n.missing ? 'error' : n.health)}">
    ${svgI('<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>')}
    <div><b>${esc(title)}</b>${n.reason ? `<div>${esc(n.reason)}</div>` : ''}
    ${n.missing ? `<div class="sub">Có tài nguyên đang trỏ tới ${esc(n.kind)} này nhưng nó không tồn tại trong cluster.</div>` : ''}</div></div>`;
}

const FACT_LABELS = { ingressController: 'Ingress controller cho', podIP: 'Pod IP', node: 'Node', restarts: 'Restarts', qos: 'QoS', cpu: 'CPU', memory: 'Memory', replicas: 'Replicas',
  ready: 'Ready', updated: 'Updated', strategy: 'Strategy', images: 'Image', type: 'Type', clusterIP: 'Cluster IP', ports: 'Ports', endpoints: 'Endpoints',
  selector: 'Selector', hosts: 'Hosts', class: 'Class', address: 'Address', schedule: 'Schedule', lastSchedule: 'Lần chạy gần nhất',
  lastSuccess: 'Thành công gần nhất', active: 'Đang chạy', succeeded: 'Thành công', failed: 'Thất bại', storageClass: 'StorageClass',
  capacity: 'Dung lượng', request: 'Yêu cầu', accessModes: 'Access modes', keys: 'Số key', serviceName: 'Service',
  roles: 'Roles', containers: 'Containers', internalIP: 'Internal IP', apiVersion: 'API version', entryPoints: 'Entry points', failurePolicy: 'Failure policy', globalDefault: 'Mặc định', preemptionPolicy: 'Preemption', attachRequired: 'Attach required', podInfoOnMount: 'Pod info on mount', os: 'OS', arch: 'Arch', kernel: 'Kernel', runtime: 'Runtime', kubelet: 'Kubelet', rules: 'Rules', subjects: 'Subjects', completions: 'Completions', duration: 'Thời gian chạy' };
const humanKey = k => FACT_LABELS[k] || String(k).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase());
// facts that a dedicated section below already shows in full
const HIDDEN_FACTS = { Node: ['kubelet'], Role: ['rules'], ClusterRole: ['rules'],
  // split columns exist for the table; the panel keeps the one-line "Ports", and the Endpoints section replaces the count
  Service: ['port', 'targetPort', 'protocol', 'nodePort', 'endpoints'],
  HorizontalPodAutoscaler: ['current', 'minReplicas', 'maxReplicas'] };
const TIME_FACTS = new Set(['lastSchedule', 'lastSuccess', 'completed']);
const MONO_FACTS = new Set(['podIP', 'clusterIP', 'images', 'image', 'internalIP', 'kubelet', 'storageClass', 'request', 'capacity', 'ports', 'selector', 'hosts', 'address', 'endpoints', 'schedule', 'node', 'cpu', 'memory']);

/* a property table: label column + value column, one row per fact */
function kv(rows) {
  const r = rows.filter(Boolean);
  return r.length ? `<div class="props">${r.map(([k, v, cls = '']) => `<div class="p-k">${esc(k)}</div><div class="p-v ${cls}">${v}</div>`).join('')}</div>` : '';
}

function factsGrid(n, skip = []) {
  const info = n.info || {};
  const hidden = [...(HIDDEN_FACTS[n.kind] || []), ...skip];
  const rows = Object.entries(info).filter(([k]) => !['lỗi', 'cpuPct', 'memPct', 'podNodes', ...hidden].includes(k)).map(([k, v]) => {
    let val = esc(v), cls = MONO_FACTS.has(k) ? 'mono' : '';
    if (TIME_FACTS.has(k) && age(v)) val = `${esc(age(v))} trước <span class="dim">· ${esc(fmtTime(v))}</span>`;
    if (k === 'restarts' && v !== '0') cls += ' warn';
    if (k === 'node') { const nd = findNode('Node', null, v); if (nd) val = `<a data-goto="${esc(nd.id)}">${val}</a>`; }
    if (k === 'images') val = String(v).split(/,\s*/).map(esc).join('<br>');
    const m = /^(\d+)\/(\d+)/.exec(v);
    const pq = n.kind === 'ResourceQuota' && /\((\d+)%\)$/.exec(v); // "500m / 2 (25%)"
    if (pq) {
      const pct = Math.min(100, +pq[1]);
      val = `<span class="ratio">${esc(String(v).replace(/\s*\(\d+%\)$/, ''))}<span class="bar"><i style="width:${pct}%;--c:${pct >= 100 ? 'var(--error)' : pct >= 90 ? 'var(--warn)' : 'var(--ok)'}"></i></span><span class="dim">${pct}%</span></span>`;
      cls = 'mono';
    } else if (['replicas', 'ready', 'updated'].includes(k) && m && Number(m[2]) > 0) {
      const pct = Math.min(100, Math.round(100 * Number(m[1]) / Number(m[2])));
      val = `<span class="ratio">${val}<span class="bar"><i style="width:${pct}%;--c:${pct === 100 ? 'var(--ok)' : pct === 0 ? 'var(--error)' : 'var(--warn)'}"></i></span></span>`;
    }
    return [humanKey(k), val, cls];
  });
  if (n.kind === 'LimitRange') return ''; // its "Giới hạn" table says the same, better laid out
  return rows.length ? block('Thông tin', null, kv(rows), '', 'half') : '';
}

const BAD_WHEN_TRUE = /Pressure|Unavailable|Failed|ReplicaFailure|Stalled|Degraded|Denied/;
const condClass = c => c.status === 'Unknown' ? 'unk' : (c.status === 'True') !== BAD_WHEN_TRUE.test(c.type) ? 'ok' : 'bad';

/*
 * What each well-known condition means, in plain words, for its good and its bad state.
 * Rows follow the resource's lifecycle (scheduled → started → ready) rather than the API's arbitrary order.
 */
const COND_INFO = {
  PodScheduled: ['Đã được xếp lên một node', 'Chưa xếp được lên node nào (thiếu tài nguyên, taint, affinity…)'],
  PodReadyToStartContainers: ['Sandbox và mạng của pod đã sẵn sàng', 'Chưa tạo xong sandbox / mạng cho pod'],
  Initialized: ['Mọi init container đã chạy xong', 'Còn init container chưa chạy xong hoặc bị lỗi'],
  ContainersReady: ['Mọi container đều đã ready', 'Có container chưa ready (đang khởi động, crash, readiness probe lỗi)'],
  Ready: ['Pod nhận được traffic từ Service', 'Pod chưa ready nên bị loại khỏi endpoint của Service'],
  DisruptionTarget: ['Pod sắp bị xoá (eviction, preemption, node drain…)', 'Không bị đánh dấu xoá'],
  Available: ['Đủ số replica tối thiểu đang chạy', 'Không đủ replica sẵn sàng (minAvailable / maxUnavailable)'],
  Progressing: ['Rollout đang tiến triển hoặc đã xong', 'Rollout bị kẹt quá progressDeadlineSeconds'],
  ReplicaFailure: ['Không tạo được pod (quota, admission webhook, lỗi spec…)', 'Tạo pod bình thường'],
  Complete: ['Job đã chạy xong thành công', 'Job chưa hoàn thành'],
  Failed: ['Job thất bại (vượt backoffLimit hoặc activeDeadlineSeconds)', 'Job chưa thất bại'],
  SuccessCriteriaMet: ['Đã đạt điều kiện thành công của Job', 'Chưa đạt điều kiện thành công'],
  FailureTarget: ['Job đang được đánh dấu thất bại', 'Không bị đánh dấu thất bại'],
  Suspended: ['Job đang tạm dừng (spec.suspend)', 'Job không bị tạm dừng'],
  MemoryPressure: ['Node đang thiếu memory, kubelet có thể evict pod', 'Node đủ memory'],
  DiskPressure: ['Node đang thiếu dung lượng đĩa', 'Node đủ dung lượng đĩa'],
  PIDPressure: ['Node sắp hết số tiến trình (PID)', 'Node đủ PID'],
  NetworkUnavailable: ['Mạng của node chưa được cấu hình đúng', 'Mạng của node bình thường'],
  AbleToScale: ['HPA đọc và đổi được số replica', 'HPA không đổi được số replica'],
  ScalingActive: ['HPA tính được số replica từ metrics', 'HPA không lấy được metrics nên không tự scale'],
  ScalingLimited: ['Số replica mong muốn bị chặn bởi min/maxReplicas', 'Không bị giới hạn bởi min/max'],
  Resizing: ['Volume đang được mở rộng', 'Không đang mở rộng'],
  FileSystemResizePending: ['Đã mở rộng volume, chờ pod mount lại để resize filesystem', 'Không chờ resize filesystem'],
  Established: ['CRD đã được API server phục vụ', 'CRD chưa được phục vụ'],
  NamesAccepted: ['Tên resource của CRD không bị trùng', 'Tên resource bị trùng với CRD khác'],
  Accepted: ['Đã được controller chấp nhận', 'Bị từ chối, hoặc chưa có controller nào xử lý'],
  Programmed: ['Đã cấu hình xong trên proxy, đang nhận traffic', 'Chưa cấu hình được trên proxy'],
  ResolvedRefs: ['Mọi backend / secret tham chiếu đều tồn tại và được phép dùng', 'Có backend / secret không tồn tại hoặc thiếu ReferenceGrant'],
  Approved: ['Yêu cầu đã được duyệt', 'Chưa được duyệt'],
  Denied: ['Yêu cầu bị từ chối', 'Không bị từ chối'],
};
// same condition type, different meaning depending on the kind
const COND_INFO_KIND = {
  APIService: { Available: ['API server gọi được tới service của API này', 'API không dùng được: kubectl top / HPA / discovery có thể lỗi'] },
  CertificateSigningRequest: { Failed: ['Ký chứng chỉ thất bại', 'Không lỗi'] },
};
// reasons that say more than the generic sentence
const REASON_INFO = {
  NewReplicaSetAvailable: 'Rollout đã hoàn tất, ReplicaSet mới đã sẵn sàng',
  ReplicaSetUpdated: 'Đang rollout ReplicaSet mới',
  FoundNewReplicaSet: 'Đã tạo ReplicaSet mới, đang rollout',
  ProgressDeadlineExceeded: 'Rollout bị kẹt quá progressDeadlineSeconds',
  DeploymentPaused: 'Rollout đang tạm dừng',
  MinimumReplicasAvailable: 'Đủ số replica tối thiểu đang chạy',
  MinimumReplicasUnavailable: 'Không đủ replica tối thiểu đang chạy',
  ContainersNotReady: 'Có container chưa ready',
  ContainersNotInitialized: 'Init container chưa chạy xong',
  Unschedulable: 'Không có node nào phù hợp để xếp pod',
  PodCompleted: 'Pod đã chạy xong, các container đã dừng',
  BackoffLimitExceeded: 'Job thất bại quá số lần cho phép (backoffLimit)',
  DeadlineExceeded: 'Job chạy quá activeDeadlineSeconds',
  KubeletReady: 'Kubelet đang chạy bình thường',
  KubeletNotReady: 'Kubelet chưa sẵn sàng (runtime, mạng hoặc PLEG lỗi)',
  NodeStatusUnknown: 'Mất liên lạc với kubelet của node',
};
const COND_ORDER = ['PodScheduled', 'PodReadyToStartContainers', 'Initialized', 'ContainersReady', 'Ready',
  'Available', 'Progressing', 'ReplicaFailure', 'SuccessCriteriaMet', 'Complete', 'FailureTarget', 'Failed', 'Suspended',
  'MemoryPressure', 'DiskPressure', 'PIDPressure', 'NetworkUnavailable', 'AbleToScale', 'ScalingActive', 'ScalingLimited'];

function condMeaning(c, cls, kind) {
  const info = COND_INFO_KIND[kind]?.[c.type] || COND_INFO[c.type];
  const isTrue = c.status === 'True';
  // the reason is more specific only where one condition covers several situations (rollout phase, kubelet state)
  const preferReason = !info || c.type === 'Progressing' || /^Kubelet|^NodeStatus/.test(c.reason || '');
  if (preferReason && c.reason && REASON_INFO[c.reason]) return REASON_INFO[c.reason];
  if (info) return isTrue ? info[0] : c.status === 'Unknown' ? 'Không xác định — chưa nhận được trạng thái' : info[1];
  return cls === 'ok' ? 'Đạt' : c.status === 'Unknown' ? 'Không xác định' : 'Không đạt';
}

function conditionsBlock(conds, kind) {
  const rank = c => { const i = COND_ORDER.indexOf(c.type); return i < 0 ? 99 : i; };
  // Node: "Ready" is the headline, the pressures follow
  const sorted = [...conds].sort((a, b) => (a.type === 'Ready' && b.type.endsWith('Pressure') ? -1 : b.type === 'Ready' && a.type.endsWith('Pressure') ? 1 : rank(a) - rank(b)));
  const bad = conds.filter(c => condClass(c) !== 'ok').length;
  const rows = sorted.map(c => {
    const cls = condClass(c);
    const raw = [c.reason, c.message].filter(Boolean).join(': ');
    return `<tr class="${cls}">
      <td class="c-name"><div class="cn"><span class="ic">${cls === 'ok' ? svgI('<path d="M5 12l5 5 9-10"/>') : cls === 'bad' ? svgI('<path d="M7 7l10 10M17 7L7 17"/>') : '?'}</span><b>${esc(c.type).replace(/([a-z])(?=[A-Z])/g, '$1<wbr>')}</b></div></td>
      <td class="c-why">${esc(condMeaning(c, cls, kind))}${raw && cls !== 'ok' ? `<div class="raw">${esc(raw)}</div>` : ''}</td>
      <td class="c-ago" title="${esc(c.lastTransitionTime ? 'Đổi trạng thái lúc ' + fmtTime(c.lastTransitionTime) : '')}">${esc(age(c.lastTransitionTime) || '—')}</td></tr>`;
  }).join('');
  const open = state.condOpen;
  const badNames = sorted.filter(c => condClass(c) !== 'ok').map(c => esc(c.type));
  const summary = bad
    ? `<span class="cs-ic bad">${svgI('<path d="M7 7l10 10M17 7L7 17"/>')}</span><span class="cs-t"><b>${badNames.join(', ')}</b> không đạt</span><span class="cs-n">${conds.length - bad}/${conds.length} đạt</span>`
    : `<span class="cs-ic ok">${svgI('<path d="M5 12l5 5 9-10"/>')}</span><span class="cs-t">Tất cả đạt</span><span class="cs-n">${conds.length}/${conds.length}</span>`;
  return block('Conditions', null, `<div class="card flush cond-card ${open ? 'open' : ''} ${bad ? 'has-bad' : ''}">
      <button class="cond-sum" data-cond-toggle aria-expanded="${!!open}" title="${open ? 'Thu gọn' : 'Xem chi tiết từng condition'}">${summary}
        <svg class="i chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></button>
      ${open ? `<table class="tbl ctbl"><thead><tr><th>Condition</th><th>Ý nghĩa</th><th class="r">Từ</th></tr></thead><tbody>${rows}</tbody></table>` : ''}</div>`,
    '', 'half');
}

/*
 * Overview, ordered by what you need first when something is wrong:
 *   problem → properties + health (conditions) → what runs (containers) → usage → kind-specific → metadata.
 * Sections marked "half" sit side by side when the panel is widened.
 */
function overviewTab(n, d) {
  const usage = typeof mxBlock === 'function' ? mxBlock(n) : '';
  // the charts show live CPU / memory precisely; the rounded snapshot in the facts would only disagree with them
  const facts = factsGrid(n, usage && n.kind !== 'Node' ? ['cpu', 'memory'] : []);
  const wrap = h => `<div class="ov">${h}</div>`;
  let html = reasonBox(n) + facts;
  if (n.missing) return wrap(html);
  if (!d) return wrap(html + usage + `<div class="dp-loading"><div class="spinner"></div>Đang tải chi tiết…</div>`);
  if (d.error) return wrap(html + usage + `<p class="muted">Không tải được chi tiết: ${esc(d.error)}</p>`);
  if (d.conditions && d.conditions.length) html += conditionsBlock(d.conditions, n.kind);
  if (d.endpoints) html += endpointsBlock(n, d.endpoints);
  // kind-specific tables from the server: webhook rules, routes, listeners, CEL validations, limit ranges…
  // up to 3 columns: a table; wider ones (webhooks, listeners, limits) as one card per row so nothing gets squeezed
  const cell = v => (v === '—' ? '<span class="dim">—</span>' : esc(v));
  for (const t of d.tables || []) html += block(t.title, t.rows.length, t.columns.length <= 3
    ? `<div class="card flush"><table class="tbl xtbl"><thead><tr>${t.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${t.rows.map(r => `<tr>${r.map((v, i) => `<td class="${i === 0 ? 'k' : ''}">${cell(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
    : t.rows.map(r => `<div class="xcard"><div class="xcard-h">${cell(r[0])}</div>${kv(t.columns.slice(1).map((c, i) => [c, cell(r[i + 1]), 'mono']))}</div>`).join(''));
  if (d.containers && d.containers.length) {
    const init = d.containers.filter(c => c.init), main = d.containers.filter(c => !c.init);
    html += block('Containers', main.length, main.map(containerCard).join(''));
    if (init.length) html += block('Init containers', init.length, init.map(containerCard).join(''));
  }
  html += usage;
  if (d.node) html += nodeDetails(d.node);
  if (d.data) html += block('Dữ liệu', d.data.length, d.data.length ? `<div class="keys">${d.data.map(x =>
    `<div><span>${esc(x.key)}</span><small>${fmtBytes(x.size)}${x.binary ? ' · binary' : ''}</small></div>`).join('')}</div>
    ${d.kind === 'Secret' ? `<p class="note">${svgI('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>')}Giá trị của Secret không bao giờ được gửi lên trình duyệt.</p>` : ''}` : '<p class="muted">Trống</p>', '', 'half');
  if (d.rules) html += block('Rules', d.rules.length, `<div class="card flush"><table class="tbl"><tr><th>Verbs</th><th>Resources</th><th>API groups</th></tr>${d.rules.map(r =>
    `<tr><td>${esc(r.verbs)}</td><td>${esc(r.resources)}</td><td>${esc(r.apiGroups)}</td></tr>`).join('')}</table></div>`);
  const labels = Object.entries(n.labels || {}), ann = Object.entries(d.annotations || {});
  const pairs = list => `<div class="labels">${list.map(([k, v]) => `<span class="lbl"><span>${esc(k)}=</span>${esc(v)}</span>`).join('')}</div>`;
  html += block('Metadata', null,
    kv([n.created && ['Tạo lúc', `${esc(fmtTime(n.created))} <span class="dim">· ${esc(age(n.created))} trước</span>`],
        n.group && ['API group', esc(n.group), 'mono']])
    + (labels.length ? `<div class="sub-h">Labels <span class="cnt">${labels.length}</span></div>${pairs(labels)}` : '')
    + (ann.length ? `<details class="ann"><summary class="sub-h">Annotations <span class="cnt">${ann.length}</span></summary>${pairs(ann)}</details>` : ''));
  return wrap(html);
}

const fmtBytes = b => b < 1024 ? `${b} B` : b < 1 << 20 ? `${(b / 1024).toFixed(1)} KiB` : `${(b / (1 << 20)).toFixed(1)} MiB`;

/* Service → the pods behind it (EndpointSlices): pod (clickable), address, node, ready / not ready / terminating */
function endpointsBlock(n, eps) {
  const sel = n.info?.selector;
  if (!eps.length) return block('Endpoints', 0, `<div class="ep-empty">${n.info?.type === 'ExternalName'
    ? `ExternalName: trỏ tới <code>${esc(n.info.externalName || '')}</code>, không có endpoint.`
    : sel ? `Không có endpoint nào. Không pod nào đang chạy khớp selector <code>${esc(sel)}</code>.`
    : 'Service không có selector: endpoint phải tạo thủ công (EndpointSlice).'}</div>`);
  const ready = eps.filter(e => e.ready).length;
  const st = e => e.terminating ? ['warn', 'đang dừng'] : e.ready ? ['ok', 'sẵn sàng'] : e.serving ? ['warn', 'serving'] : ['error', 'chưa ready'];
  const rows = eps.map(e => {
    const [h, label] = st(e);
    const t = e.target && findNode(e.targetKind || 'Pod', e.targetNs, e.target);
    const tgt = e.target ? (t ? `<a data-goto="${esc(t.id)}">${esc(e.target)}</a>` : esc(e.target)) : '<span class="dim">—</span>';
    const nd = e.node && findNode('Node', null, e.node);
    const port = (e.ports || '').split(', ').map(p => p.replace(/^\S+ (?=\d)/, '').replace('/TCP', '')).join(', ');
    const node = e.node ? (nd ? `<a data-goto="${esc(nd.id)}">${esc(typeof shortNode === 'function' ? shortNode(e.node) : e.node)}</a>` : esc(e.node)) : '';
    return `<tr class="${h}"><td class="k"><div class="ep-p"><span class="ep-dot" style="--c:var(--${h})" title="${label}"></span><span class="ep-n" title="${esc(e.target || '')}">${tgt}</span></div>
        ${node ? `<div class="ep-sub">node ${node}</div>` : ''}</td>
      <td class="mono">${esc(e.ip)}${port ? `<span class="dim">:${esc(port)}</span>` : ''}</td>
      <td class="ep-st" style="--c:var(--${h})">${label}</td></tr>`;
  }).join('');
  return block('Endpoints', eps.length, `<div class="card flush"><table class="tbl xtbl eptbl"><thead><tr><th>Pod</th><th>Địa chỉ</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`,
    `<span class="${ready === eps.length ? 'ok-n' : ready ? 'bad-n' : 'bad-n'}">${ready}/${eps.length} sẵn sàng</span>`);
}

function block(title, count, body, aside = '', cls = '') {
  return `<section class="blk ${cls}"><h3>${esc(title)}${count != null ? `<span class="cnt">${count}</span>` : ''}${aside ? `<span class="aside">${aside}</span>` : ''}</h3>${body}</section>`;
}

function containerCard(c) {
  const st = c.state === 'running' ? (c.ready === false ? 'warn' : 'ok') : c.state === 'waiting' ? (/BackOff|Err|Invalid|Config/.test(c.reason || '') ? 'error' : 'warn')
    : c.state === 'terminated' ? (c.exitCode === 0 ? 'ok' : 'error') : 'unknown';
  const stateText = c.state ? `${c.reason || c.state}${c.state === 'running' ? (c.ready ? ' · ready' : ' · chưa ready') : ''}${c.exitCode != null ? ' · exit ' + c.exitCode : ''}` : 'template';
  const res = o => o && Object.keys(o).length ? Object.entries(o).map(([k, v]) => `<span class="q"><span class="dim">${esc(k)}</span> ${esc(v)}</span>`).join('') : '';
  const last = c.lastState;
  const noRes = !Object.keys(c.requests || {}).length && !Object.keys(c.limits || {}).length;
  return `<div class="ctr" style="--c:${hvar(st)}">
    <div class="ctr-h"><i></i><b>${esc(c.name)}</b>
      <span class="st">${esc(stateText)}</span>
      ${c.restarts ? `<span class="rs" title="số lần restart">${svgI('<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>')}${c.restarts}</span>` : ''}</div>
    ${c.message ? `<div class="ctr-msg">${esc(c.message)}</div>` : ''}
    ${kv([
      ['Image', esc(c.image), 'mono'],
      last && ['Lần chạy trước', `<span class="bad">${esc(last.reason)}</span> · exit ${esc(last.exitCode)}${last.finishedAt ? ` · ${age(last.finishedAt)} trước` : ''}${last.message ? `<div class="dim">${esc(last.message)}</div>` : ''}`],
      noRes ? ['Tài nguyên', '<span class="dim">không đặt requests/limits</span>'] : null,
      res(c.requests) && ['Requests', res(c.requests), 'mono'],
      res(c.limits) && ['Limits', res(c.limits), 'mono'],
      c.usage && res(c.usage) && ['Đang dùng', res(c.usage), 'mono'],
      (c.ports || []).length && ['Ports', esc(c.ports.join(', ')), 'mono'],
      ...Object.entries(c.probes || {}).map(([k, v]) => [k[0].toUpperCase() + k.slice(1), esc(v)]),
    ])}
  </div>`;
}

/* "32532612Ki" / "200492418301" → "31.0Gi" / "186.7Gi"; cpu and pod counts stay as they are */
function fmtQty(q, bytes) {
  if (!bytes || q == null) return String(q ?? '?');
  const m = /^(\d+(?:\.\d+)?)(Ki|Mi|Gi|Ti|k|M|G)?$/.exec(String(q));
  if (!m) return String(q);
  const mult = { Ki: 1024, Mi: 1 << 20, Gi: 1 << 30, Ti: 2 ** 40, k: 1e3, M: 1e6, G: 1e9 }[m[2]] || 1;
  const b = Number(m[1]) * mult;
  return b >= 2 ** 40 ? (b / 2 ** 40).toFixed(1) + 'Ti' : b >= 1 << 30 ? (b / (1 << 30)).toFixed(1) + 'Gi' : Math.round(b / (1 << 20)) + 'Mi';
}

function nodeDetails(nd) {
  const cap = [];
  for (const r of ['cpu', 'memory', 'pods', 'ephemeral-storage']) {
    if (!nd.allocatable || !nd.allocatable[r]) continue;
    const bytes = r === 'memory' || r === 'ephemeral-storage';
    cap.push([r === 'ephemeral-storage' ? 'Ephemeral storage' : r === 'cpu' ? 'CPU' : r === 'pods' ? 'Pods' : 'Memory',
      `${esc(fmtQty(nd.allocatable[r], bytes))} <span class="dim">/ ${esc(fmtQty(nd.capacity?.[r], bytes))}</span>`, 'mono']);
  }
  cap.push(['Pod đang chạy', esc(String(nd.pods)), 'mono']);
  if (nd.unschedulable) cap.push(['Cordoned', 'có, không nhận pod mới', 'warn']);
  const sys = Object.entries(nd.system || {}).map(([k, v]) => [humanKey(k), esc(v), k === 'kernel' || k === 'runtime' || k === 'kubelet' ? 'mono' : '']);
  sys.push(['Taints', nd.taints.length ? esc(nd.taints.join(', ')) : '<span class="dim">không có</span>', nd.taints.length ? 'mono' : '']);
  return block('Khả dụng / Tổng', null, kv(cap), '', 'half') + block('Hệ thống', null, kv(sys), '', 'half');
}

function eventsTab(d) {
  if (!d) return `<div class="dp-loading"><div class="spinner"></div>Đang tải…</div>`;
  const evs = d.events || [];
  if (!evs.length) return `<div class="dp-empty-tab">Không có event nào gần đây.<div class="sub">Kubernetes thường chỉ giữ event khoảng 1 giờ.</div></div>`;
  return `<div class="timeline">${evs.map(e => `
    <div class="tl ${e.type === 'Warning' ? 'w' : ''}"><i></i>
      <div class="tl-h"><b>${esc(e.reason)}</b>${e.count > 1 ? `<span class="cnt">×${e.count}</span>` : ''}<span class="ago" title="${esc(e.last)}">${esc(age(e.last) || '')}</span></div>
      <div class="tl-m">${esc(e.message)}</div>${e.source ? `<div class="tl-s">${esc(e.source)}</div>` : ''}</div>`).join('')}</div>`;
}

function relationsTab(n, groups) {
  const entries = Object.entries(groups);
  if (!entries.length) return `<div class="dp-empty-tab">Không có quan hệ nào.</div>`;
  return entries.map(([title, list]) => `<div class="blk"><h3>${esc(title)}<span class="cnt">${list.length}</span></h3>` +
    list.map(o => {
      const ok = kindInfo(o);
      return `<div class="rel" data-id="${esc(o.id)}"><div class="mini" style="--c:${ok.color}">${icon(iconKind(o))}</div>
        <div class="nm"><small>${esc(ok.label)}</small>${esc(o.name)}${o.namespace && o.namespace !== n.namespace ? ` <small>(${esc(o.namespace)})</small>` : ''}</div>
        ${o.status ? `<span class="st" style="--c:${hvar(o.health)}"><i></i>${esc(truncMid(o.status, 18))}</span>` : ''}</div>`;
    }).join('') + '</div>').join('');
}

/* History tab: rollout revisions (ReplicaSets / ControllerRevisions), newest first */
async function renderHistoryTab(n, keep) {
  const key = 'history:' + n.id;
  if (keep && $('dpBody').dataset.key === key && state.history?.id === n.id) return;
  $('dpBody').dataset.key = key; $('dpBody').dataset.html = '';
  $('dpBody').innerHTML = `<div class="dp-loading"><div class="spinner"></div>Đang tải lịch sử…</div>`;
  try {
    const r = await fetch('/api/actions/history?' + new URLSearchParams({ kind: n.kind, namespace: n.namespace, name: n.name }));
    const list = await r.json();
    if (!r.ok) throw new Error(list.error || r.statusText);
    if ($('dpBody').dataset.key !== key) return;
    state.history = { id: n.id, list };
    $('dpBody').innerHTML = `<div class="yaml-bar"><span class="muted small">${list.length} revision · ${n.kind === 'Deployment' ? 'lưu trong ReplicaSet cũ' : 'lưu trong ControllerRevision'} (giữ tối đa theo <code>revisionHistoryLimit</code>)</span>
        <button class="tool" data-hist="reload"><svg class="i" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5"/></svg>Tải lại</button></div>
      <div class="revs">${list.map(r => `<div class="rev ${r.current ? 'cur' : ''}">
        <div class="rev-h"><b>Revision ${r.revision}</b>${r.current ? '<span class="tag">đang chạy</span>' : ''}<span class="ago" title="${esc(r.created)}">${esc(age(r.created) || '')} trước</span></div>
        <div class="img">${esc(r.images.join(', ') || '—')}</div>
        ${r.changeCause ? `<div class="cause">${esc(r.changeCause)}</div>` : ''}
        ${r.current ? '' : `<div class="rev-btns"><button class="tool" data-act="hist-diff" data-rev="${r.revision}">So sánh với hiện tại</button>
          ${state.writeEnabled ? `<button class="tool" data-act="rollback" data-rev="${r.revision}"><svg class="i" viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>Rollback về đây</button>` : ''}</div>`}
      </div>`).join('')}</div>`;
  } catch (e) {
    $('dpBody').innerHTML = `<p class="muted">Không tải được lịch sử: ${esc(e.message)}</p>`;
  }
}

/* Describe tab: `kubectl describe`-identical text generated by the server (no kubectl needed), loaded once per object */
async function renderDescribeTab(n, keep) {
  const key = 'describe:' + n.id;
  if (keep && $('dpBody').dataset.key === key) return;
  $('dpBody').dataset.key = key; $('dpBody').dataset.html = '';
  $('dpBody').innerHTML = `<div class="yaml-tab">
    <div class="yaml-bar"><code class="muted small" id="descCmd">describe …</code>
      <button class="tool" data-desc="reload"><svg class="i" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5"/></svg>Tải lại</button>
      <button class="tool" data-desc="copy">Sao chép</button></div>
    <pre class="describe" id="descText"><span class="muted">Đang tải…</span></pre></div>`;
  try {
    const r = await fetch('/api/describe?' + new URLSearchParams({ kind: n.kind, group: n.group || '', namespace: n.namespace || '', name: n.name }));
    const body = await r.json();
    if ($('dpBody').dataset.key !== key) return;
    if (!r.ok) throw new Error(body.error || r.statusText);
    $('descCmd').textContent = body.command;
    $('descText').innerHTML = highlightDescribe(body.text);
    $('descText').dataset.raw = body.text;
  } catch (e) {
    if ($('descText')) $('descText').innerHTML = `<span class="desc-err">${esc(e.message)}</span>`;
  }
}

/* light highlighting: top-level "Field:" headers, nested headers, Warning events, <none> values */
function highlightDescribe(text) {
  return text.split('\n').map(line => {
    let h = esc(line);
    if (/^\S[^:]*:/.test(line)) h = h.replace(/^([^:]+:)/, '<b class="dk">$1</b>');
    else if (/^ {2,}[A-Z][\w .()/-]*:\s*$/.test(line)) h = `<b class="dk2">${h}</b>`;
    if (/^\s+Warning\s/.test(line)) h = `<span class="dw">${h}</span>`;
    else if (/^\s+Normal\s/.test(line)) h = `<span class="dn">${h}</span>`;
    return h.replace(/&lt;none&gt;|&lt;unset&gt;/g, m => `<span class="dnone">${m}</span>`);
  }).join('\n');
}

/* YAML tab: read-only live manifest; loaded once per object, refreshed on demand */
async function renderYamlTab(n, keep) {
  const key = 'yaml:' + n.id;
  if (keep && $('dpBody').dataset.key === key) return;
  $('dpBody').dataset.key = key; $('dpBody').dataset.html = '';
  $('dpBody').innerHTML = `<div class="yaml-tab">
    <div class="yaml-bar"><span class="muted small" id="yamlRv">Đang tải…</span>
      <button class="tool" data-yaml="reload"><svg class="i" viewBox="0 0 24 24"><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8M21 3v5h-5"/></svg>Tải lại</button>
      <button class="tool" data-yaml="copy">Sao chép</button>
      <button class="tool" data-yaml="compare" title="So sánh với một ${esc(n.kind)} khác"><svg class="i" viewBox="0 0 24 24"><path d="M8 3v18M16 3v18M3 8h5M16 16h5"/></svg>So sánh…</button>
      ${state.writeEnabled ? `<button class="tool primary" data-act="manifest"><svg class="i" viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>Sửa</button>` : ''}</div>
    <div class="yaml-view" id="yamlView"></div></div>`;
  try {
    const r = await fetch('/api/actions/manifest?' + new URLSearchParams({ kind: n.kind, namespace: n.namespace || '', name: n.name }));
    const m = await r.json();
    if (!r.ok) throw new Error(m.error || r.statusText);
    if ($('dpBody').dataset.key !== key) return;
    $('yamlRv').textContent = `resourceVersion ${m.resourceVersion}${m.secret ? ' · giá trị Secret đã được che' : ''}`;
    state.yamlView = CodeMirror($('yamlView'), { value: m.yaml, mode: 'yaml', readOnly: true, lineNumbers: true });
    setTimeout(() => state.yamlView && state.yamlView.refresh(), 50);
  } catch (e) {
    if ($('yamlRv')) $('yamlRv').textContent = 'Không tải được: ' + e.message;
  }
}

/* fetch /api/details (containers, events, conditions…) at most every 4s per selected object */
let detailsTimer = null;
function loadDetails(n) {
  const fresh = state.details.id === n.id && Date.now() - state.details.at < 4000;
  if (fresh || detailsTimer) return;
  detailsTimer = setTimeout(async () => {
    detailsTimer = null;
    const id = n.id;
    try {
      const r = await fetch('/api/details?' + new URLSearchParams({ kind: n.kind, namespace: n.namespace || '', name: n.name }));
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      const changed = JSON.stringify(body) !== JSON.stringify(state.details.id === id ? state.details.data : null);
      state.details = { id, at: Date.now(), data: body };
      if (state.selected === id && changed) {
        const raw = state.graph.nodes.find(x => x.id === id);
        if (raw) showDetailRaw(raw, true);
      }
    } catch (e) {
      state.details = { id, at: Date.now(), data: { error: e.message } };
    }
  }, state.details.id === n.id ? 0 : 50);
}

/* tabs, panel width, YAML tab buttons */
const closeMore = () => { if (!state.moreOpen) return; state.moreOpen = null; const n = state.graph.nodes.find(x => x.id === state.selected); if (n) patch('dpHead', panelHeader(n, state.details.id === n.id ? state.details.data : null)); };
document.addEventListener('pointerdown', e => { if (state.moreOpen && !e.target.closest('.dp-more-wrap')) closeMore(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && state.moreOpen) { e.stopPropagation(); closeMore(); } }, true);
$('detail').addEventListener('click', e => {
  if (e.target.closest('[data-more]')) {
    state.moreOpen = state.moreOpen === state.selected ? null : state.selected;
    const n = state.graph.nodes.find(x => x.id === state.selected);
    if (n) patch('dpHead', panelHeader(n, state.details.id === n.id ? state.details.data : null));
    const menu = document.querySelector('.dp-menu'); // keep it inside the panel: open to the right when there is no room on the left
    if (menu && menu.getBoundingClientRect().left < $('detail').getBoundingClientRect().left + 8) { menu.style.right = 'auto'; menu.style.left = '0'; }
    return;
  }
  if (e.target.closest('.dp-menu .mi')) setTimeout(closeMore); // after the item's own handler ran
  if (e.target.closest('[data-cond-toggle]')) {
    state.condOpen = !state.condOpen; store.set('condOpen', state.condOpen ? '1' : '0');
    const n = state.graph.nodes.find(x => x.id === state.selected); if (n) showDetailRaw(n, true);
    $('detail').querySelector('[data-cond-toggle]')?.focus({ preventScroll: true });
    return;
  }
  const cpn = e.target.closest('[data-copyname]');
  if (cpn) { navigator.clipboard?.writeText(cpn.dataset.copyname).then(() => typeof toast === 'function' && toast('Đã sao chép tên')); return; }
  const t = e.target.closest('[data-tab]');
  if (t) {
    state.tab = t.dataset.tab; store.set('tab', state.tab);
    const n = state.graph.nodes.find(x => x.id === state.selected);
    if (n) { $('dpBody').dataset.key = ''; $('dpBody').dataset.html = ''; $('dpBody').scrollTop = 0; showDetailRaw(n, true); }
    return;
  }
  if (e.target.closest('#dpWide')) { togglePanelWide(); return; }
  if (e.target.closest('#dpMode')) { togglePanelMode(); return; }
  const dsc = e.target.closest('[data-desc]');
  if (dsc) {
    if (dsc.dataset.desc === 'reload') { const n = state.graph.nodes.find(x => x.id === state.selected); if (n) renderDescribeTab(n, false); }
    if (dsc.dataset.desc === 'copy' && $('descText')?.dataset.raw) navigator.clipboard?.writeText($('descText').dataset.raw).then(() => typeof toast === 'function' && toast('Đã sao chép'));
    return;
  }
  if (e.target.closest('[data-hist=reload]')) { const n = state.graph.nodes.find(x => x.id === state.selected); if (n) { state.history = null; renderHistoryTab(n, false); } return; }
  const y = e.target.closest('[data-yaml]');
  if (y && y.dataset.yaml === 'reload') { const n = state.graph.nodes.find(x => x.id === state.selected); if (n) renderYamlTab(n, false); }
  if (y && y.dataset.yaml === 'compare') { const n = state.graph.nodes.find(x => x.id === state.selected); if (n && typeof compareObject === 'function') compareObject(n); }
  if (y && y.dataset.yaml === 'copy' && state.yamlView) navigator.clipboard?.writeText(state.yamlView.getValue()).then(() => typeof toast === 'function' && toast('Đã sao chép YAML'));
});
$('detail').addEventListener('scroll', e => { const t = e.target; if (t.id === 'dpTabs') t.classList.toggle('ovf', t.scrollLeft + t.clientWidth < t.scrollWidth - 2); }, true);

/*
 * Panel width: one number (--panel-w, px), persisted. Drag the left edge, arrow keys on it, double-click = default.
 * The ⤢ button jumps between the user's normal width and "wide" (62% of the area). Layout inside the panel
 * (two columns…) follows the real width through a container query, not a mode flag. The area left of the panel
 * keeps at least MIN_REST px, also when the window shrinks; dragging past the right edge closes the panel.
 */
const PANEL_DEFAULT = 440, PANEL_MIN = 320, MIN_REST = 360, CLOSE_BELOW = 220;
const mainW = () => $('main').getBoundingClientRect().width || window.innerWidth;
/*
 * Push or overlay, remembered per kind of view: the graph pushes (it stays whole and clickable next to the details),
 * lists (table, timeline, Helm, security) get an overlay so their columns aren't squeezed. The button in the panel
 * header switches the current view's mode.
 */
const panelViewKey = () => (document.querySelector('.app-view:not([hidden])') ? 'list' : 'graph');
const panelMode = () => store.get('panelMode.' + panelViewKey()) || (panelViewKey() === 'graph' ? 'push' : 'overlay');
const panelModeIcon = () => (panelMode() === 'overlay'
  ? '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="11" y="7" width="8" height="10" rx="1.5"/>'   // floating card
  : '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>');                                  // split
const panelModeTitle = () => (panelMode() === 'overlay' ? 'Đang đè lên nội dung — bấm để đẩy nội dung sang' : 'Đang đẩy nội dung sang — bấm để đè lên nội dung');
const panelMax = () => Math.max(PANEL_MIN, mainW() - (panelMode() === 'overlay' ? 120 : MIN_REST));
const clampPanel = w => Math.round(Math.max(PANEL_MIN, Math.min(panelMax(), w)));
const wideTarget = () => clampPanel(mainW() * 0.62);
let panelW = (() => { const w = parseInt(store.get('panelW')); return w >= PANEL_MIN ? w : PANEL_DEFAULT; })();
function panelIsWide() { return panelW >= Math.min(wideTarget(), panelMax()) - 8 && panelW > PANEL_DEFAULT + 40; }
function applyPanelW(w, persist = true) {
  panelW = w;
  const shown = clampPanel(w); // never wider than the window allows; the wish (panelW) stays for when it grows again
  $('main').style.setProperty('--panel-w', shown + 'px');
  const h = $('dpResize');
  if (h) { h.setAttribute('aria-valuenow', shown); h.setAttribute('aria-valuemax', Math.round(panelMax())); }
  if (persist) store.set('panelW', String(Math.round(w)));
}
function refreshWideButton() {
  const b = $('dpWide'); if (!b) return;
  const wide = panelIsWide();
  b.title = wide ? 'Thu hẹp panel' : 'Mở rộng panel';
  b.setAttribute('aria-pressed', wide);
  b.innerHTML = svgI(wide ? '<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>' : '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>');
}
function togglePanelWide() {
  if (panelIsWide()) applyPanelW(parseInt(store.get('panelWNormal')) || PANEL_DEFAULT);
  else { store.set('panelWNormal', String(clampPanel(panelW))); applyPanelW(wideTarget()); }
  refreshWideButton();
}
function applyPanelMode() {
  $('main').classList.toggle('panel-overlay', panelMode() === 'overlay');
  applyPanelW(panelW, false);
  const b = $('dpMode');
  if (b) { b.title = panelModeTitle(); b.setAttribute('aria-pressed', panelMode() === 'overlay'); b.innerHTML = svgI(panelModeIcon()); }
  refreshWideButton();
}
function togglePanelMode() {
  store.set('panelMode.' + panelViewKey(), panelMode() === 'overlay' ? 'push' : 'overlay');
  applyPanelMode();
}
applyPanelMode();
addEventListener('resize', () => applyPanelW(panelW, false));
/*
 * Overlay mode: a click on the empty background of the list view (not a row, button, field, the sidebar or toolbars)
 * closes the panel, like a drawer. Never on a drag / text selection, nor while a scale or the ⋯ menu is open.
 * (Push mode: the graph's own empty-background tap already closes it.)
 */
const PANEL_BG = '.app-view, .gv-body, .gv-main, .gv-wrap, .tl-rows, .tl-empty, .hm-body, .hm-main, .hm-list, .hm-detail, .sec-body, .sec-list';
let panelDown = null;
// capture phase: runs before the ⋯ menu's own outside-click handler closes it, so we still see it was open
document.addEventListener('pointerdown', e => { panelDown = { x: e.clientX, y: e.clientY, t: e.target, busy: !!(state.moreOpen || state.scaleOpen) }; }, true);
document.addEventListener('click', e => {
  const m = $('main');
  if (!m.classList.contains('panel-overlay') || m.classList.contains('no-panel')) return;
  if (!panelDown || panelDown.t !== e.target || Math.hypot(e.clientX - panelDown.x, e.clientY - panelDown.y) > 5) return;
  if (!e.target.matches?.(PANEL_BG) || !getSelection().isCollapsed || panelDown.busy) return; // first click only closes the menu
  clearDetail();
});
// switching between the graph and a list view switches to that view's mode
new MutationObserver(applyPanelMode).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden'] });

/* everything that depends on the panel size follows it: graph canvas, tab overflow fade, YAML viewer, wide button */
new ResizeObserver(() => { if (typeof cy !== 'undefined') cy.resize(); }).observe($('cy'));
new ResizeObserver(() => {
  const t = $('dpTabs'); if (t) t.classList.toggle('ovf', t.scrollWidth > t.clientWidth + 2 && t.scrollLeft + t.clientWidth < t.scrollWidth - 2);
  state.yamlView && state.yamlView.refresh();
  refreshWideButton();
}).observe($('detail'));

$('detail').addEventListener('pointerdown', e => {
  const h = e.target.closest('#dpResize');
  if (!h || e.button !== 0) return;
  e.preventDefault();
  h.setPointerCapture(e.pointerId);
  $('main').classList.add('resizing');
  const right = $('main').getBoundingClientRect().right;
  let raf = 0, want = panelW, closing = false;
  const move = ev => {
    want = right - ev.clientX;
    closing = want < CLOSE_BELOW;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      $('main').classList.toggle('closing-panel', closing);
      if (!closing) applyPanelW(clampPanel(want), false);
      h.dataset.w = closing ? 'thả để đóng' : clampPanel(want) + 'px';
    });
  };
  const up = () => {
    h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); h.removeEventListener('pointercancel', up);
    $('main').classList.remove('resizing', 'closing-panel');
    delete h.dataset.w;
    if (closing) { setPanel(false); return; } // the saved width stays for next time
    applyPanelW(clampPanel(want));
  };
  h.addEventListener('pointermove', move); h.addEventListener('pointerup', up); h.addEventListener('pointercancel', up);
});
$('detail').addEventListener('dblclick', e => { if (e.target.closest('#dpResize')) { applyPanelW(PANEL_DEFAULT); refreshWideButton(); } });
$('detail').addEventListener('keydown', e => {
  if (!e.target.closest('#dpResize')) return;
  const step = e.shiftKey ? 96 : 24, cur = clampPanel(panelW);
  const next = { ArrowLeft: cur + step, ArrowRight: cur - step, Home: PANEL_MIN, End: panelMax() }[e.key];
  if (e.key === 'Enter') { e.preventDefault(); togglePanelWide(); return; }
  if (next == null) return;
  e.preventDefault(); e.stopPropagation();
  applyPanelW(clampPanel(next));
});

/* namespace (group / tile) panel */
function showNsPanel(ns) {
  state.selected = null; state.panelNs = ns;
  delete $('detail').dataset.id;
  setPanel(true);
  cy.$(':selected').unselect();
  const place = placement(state.graph);
  const nodes = state.graph.nodes.filter(n => place.get(n.id) === ns);
  const s = summarize(nodes, ns);
  const expanded = state.expanded.has(ns);
  const problems = nodes.filter(n => n.health === 'error' || n.health === 'warn').sort((a, b) => (a.health === 'error' ? 0 : 1) - (b.health === 'error' ? 0 : 1));
  const nsNode = state.graph.nodes.find(n => n.kind === 'Namespace' && n.name === ns);
  const a = nsNode && age(nsNode.created);
  $('detail').innerHTML = `<div class="dp">
    <div class="dp-resize" id="dpResize" role="separator" aria-orientation="vertical" aria-label="Độ rộng panel" tabindex="0" title="Kéo để đổi độ rộng · nhấp đúp: mặc định · kéo hết sang phải: đóng"></div>
    <header class="dp-head">
      <div class="dp-top">
        <div class="tile" style="--c:var(--accent)"><svg class="i" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3" stroke-dasharray="3 3"/></svg></div>
        <div class="dp-id"><div class="dp-kind">Namespace${s.system ? '<span class="ns">hệ thống</span>' : ''}</div><h2>${esc(s.label)}</h2></div>
        <button class="icon-btn sm" id="dclose" title="Đóng (Esc)">${svgI('<path d="M6 6l12 12M18 6L6 18"/>')}</button>
      </div>
      <div class="dp-status">
        ${s.err ? `<span class="pill h" style="--c:var(--error)"><i></i>${s.err} lỗi</span>` : ''}
        ${s.warn ? `<span class="pill h" style="--c:var(--warn)"><i></i>${s.warn} cảnh báo</span>` : ''}
        <span class="pill h" style="--c:var(--ok)"><i></i>${s.ok} ổn định</span>
        ${a ? `<span class="meta">${svgI('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>')}${a}</span>` : ''}
      </div>
      <div class="dp-tools">
        <button class="tool" data-ns-act="${expanded ? 'collapse' : 'expand'}">${expanded ? svgI('<path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/>') + 'Thu gọn' : svgI('<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/>') + 'Mở rộng trên sơ đồ'}</button>
        ${ns !== CLUSTER ? `<button class="tool" data-ns-act="open">${svgI('<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>')}Chỉ xem namespace này</button>` : ''}
      </div>
    </header>
    <div class="dp-body">
      ${block('Tổng quan', null, kv([['Workload', String(s.workloads), 'mono'], ['Pod', String(s.pods), 'mono'], ['Service', String(s.services), 'mono'], ['Tổng tài nguyên', String(s.total), 'mono']]))}
      ${block('Cần chú ý', problems.length, problems.length ? `<div class="rels">${problems.slice(0, 40).map(o => {
        const ok = kindInfo(o);
        return `<div class="rel two" data-id="${esc(o.id)}"><div class="mini" style="--c:${ok.color}">${icon(iconKind(o))}</div>
          <div class="nm"><small>${esc(ok.label)}</small>${esc(o.name)}${o.reason ? `<div class="why">${esc(o.reason)}</div>` : ''}</div>
          <span class="st" style="--c:${hvar(o.health)}"><i></i>${esc(truncMid(o.status, 16))}</span></div>`;
      }).join('')}</div>` : `<div class="dp-empty-tab">Không có vấn đề nào</div>`)}
    </div></div>`;
}

function expandNs(ns, focus = true) {
  state.expanded.add(ns); saveExpanded();
  if (focus) state.focusNs = ns;
  render(false);
}
function collapseNs(ns) {
  state.expanded.delete(ns); saveExpanded();
  render(false);
}
function openNs(ns) { $('ns').value = ns; $('ns').dispatchEvent(new Event('change')); }

$('detail').addEventListener('click', e => {
  if (e.target.closest('#dclose')) { cy.$(':selected').unselect(); clearDetail(); return; }
  if (e.target.closest('#openLogs')) { openLogsFor(state.selected); return; }
  const act = e.target.closest('[data-ns-act]');
  if (act) {
    const ns = state.panelNs, a = act.dataset.nsAct;
    if (a === 'expand') expandNs(ns); else if (a === 'collapse') collapseNs(ns); else if (a === 'open') openNs(ns);
    if (a !== 'open') showNsPanel(ns);
    return;
  }
  const r = e.target.closest('.rel, [data-goto]'); if (!r) return;
  const id = r.dataset.id || r.dataset.goto;
  let n = cy.getElementById(id);
  if (n.empty() && isAll()) { // inside a collapsed namespace: expand it first
    const raw = state.graph.nodes.find(x => x.id === id);
    if (raw) { expandNs(placement(state.graph).get(id), false); n = cy.getElementById(id); }
  }
  if (n.empty()) { const raw = state.graph.nodes.find(x => x.id === id); if (raw) showDetailRaw(raw); return; }
  cy.$(':selected').unselect(); n.select(); showDetail(n);
  cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 0.7), duration: 350, easing: 'ease-out-cubic' });
});

/* ================= interactions ================= */
cy.on('tap', 'node.card', e => {
  const pg = e.target.data('raw')?.podGroup;
  if (pg) { state.podGroupsOpen.add(pg); state.structureKey = ''; render(false); toast('Đã mở ' + e.target.data('raw').podIds.length + ' pod'); return; }
  showDetail(e.target);
});
cy.on('tap', 'node.tile', e => { const ns = e.target.data('ns'); expandNs(ns); showNsPanel(ns); });
cy.on('tap', 'node.group', e => showNsPanel(e.target.data('ns')));
cy.on('tap', e => { if (e.target === cy) clearDetail(); });
cy.on('dbltap', 'node.card', e => { if (typeof podsFor === 'function' && podsFor(e.target.id()).length) openLogsFor(e.target.id()); });
cy.on('dbltap', 'node.group', e => { const ns = e.target.data('ns'); if (ns !== CLUSTER) openNs(ns); });
cy.on('mouseover', 'node.card', e => { state.hovered = e.target.id(); e.target.addClass('hover'); applyFocus(); $('cy').style.cursor = dragMode ? 'grab' : 'pointer'; });
cy.on('mouseout', 'node.card', e => { state.hovered = null; e.target.removeClass('hover'); applyFocus(); $('cy').style.cursor = ''; });
cy.on('mouseover', 'node.group, node.tile', e => { e.target.addClass('hover'); $('cy').style.cursor = dragMode ? 'grab' : 'pointer'; });
cy.on('mouseout', 'node.group, node.tile', e => { e.target.removeClass('hover'); $('cy').style.cursor = ''; });

/* kind filter state; the filter bar UI lives in filters.js */
for (const c of CHIPS) {
  const saved = store.get('chip.' + c.id);
  chipOn[c.id] = saved === null ? c.on : saved === '1';
}
/* icon-only buttons: expose their tooltip as the accessible name */
document.querySelectorAll('button[title]').forEach(b => { if (!b.textContent.trim() && !b.hasAttribute('aria-label')) b.setAttribute('aria-label', b.title); });
/* legend */
const setLegend = open => { $('legend').classList.toggle('open', open); $('legendBtn').setAttribute('aria-expanded', String(open)); store.set('legend', open ? '1' : '0'); };
$('legendBtn').onclick = () => setLegend(!$('legend').classList.contains('open'));
setLegend(store.get('legend') === '1');
document.querySelectorAll('.hchip[data-h]').forEach(b => b.onclick = () => {
  state.health = state.health === b.dataset.h ? null : b.dataset.h; updateCounts(); applyFocus(); // dims only, never moves the view
});
$('q').addEventListener('input', e => { state.query = e.target.value.trim(); applyFocus(); });
$('zin').onclick = () => cy.animate({ zoom: { level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 150 });
$('zout').onclick = () => cy.animate({ zoom: { level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } }, duration: 150 });
$('fit').onclick = () => cy.animate({ fit: { padding: 40 }, duration: 300 });
$('relayout').onclick = () => { state.manual.clear(); layout(true, true); };
let expandArmed = null;
$('expandAll').onclick = () => {
  const total = simplifyGraph(state.graph).nodes.filter(isVisible).length; // cards actually drawn (big pod sets are grouped)
  if (total > 300 && !expandArmed) { // two-step confirm instead of a blocking dialog
    const btn = $('expandAll'), old = btn.innerHTML;
    btn.innerHTML = `Vẽ ${total} thẻ? Bấm lần nữa`;
    expandArmed = setTimeout(() => { expandArmed = null; btn.innerHTML = old; }, 3500);
    btn.dataset.old = old;
    return;
  }
  if (expandArmed) { clearTimeout(expandArmed); expandArmed = null; $('expandAll').innerHTML = $('expandAll').dataset.old; }
  const place = placement(state.graph);
  new Set(place.values()).forEach(ns => state.expanded.add(ns)); saveExpanded(); render(true);
};
$('collapseAll').onclick = () => { state.expanded.clear(); saveExpanded(); render(true); };
$('theme').onclick = () => { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; store.set('theme', t); applyTheme(t); };
$('togglePanel').onclick = () => {
  if ($('main').classList.contains('no-panel')) { if (!state.selected && !state.panelNs) clearDetail(true); setPanel(true); }
  else setPanel(false);
};
document.addEventListener('keydown', e => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === '/' && !typing) { e.preventDefault(); $('q').focus(); }
  if (e.key === 'Escape' && typeof closeLogs === 'function' && !$('logs').hidden) { closeLogs(); return; }
  if (!typing && state.selected && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
    e.preventDefault(); moveSelection(e.key); return;
  }
  const onControl = document.activeElement?.matches?.('button, a, summary, [role=tab], [tabindex]:not(#cy)');
  if (!typing && !onControl && state.selected && e.key === 'Enter' && typeof podsFor === 'function' && podsFor(state.selected).length) {
    openLogsFor(state.selected); return;
  }
  if (e.key === 'Escape') { $('q').value = ''; state.query = ''; state.health = null; $('q').blur(); cy.$(':selected').unselect(); clearDetail(); updateCounts(); applyFocus(); }
});

/* nearest card in the arrow's direction (within a 45° cone), favouring straight lines */
function moveSelection(key) {
  const cur = cy.getElementById(state.selected); if (cur.empty()) return;
  const p = cur.position(), dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[key];
  let best = null, bestScore = Infinity;
  cy.nodes('.card').forEach(n => {
    if (n.same(cur) || n.hasClass('lod')) return;
    const q = n.position(), dx = q.x - p.x, dy = q.y - p.y;
    const along = dx * dir[0] + dy * dir[1], across = Math.abs(dx * dir[1] - dy * dir[0]);
    if (along <= 0 || across > along) return;
    const score = along + across * 2;
    if (score < bestScore) { bestScore = score; best = n; }
  });
  if (!best) return;
  cy.$(':selected').unselect(); best.select(); showDetail(best);
  cy.animate({ center: { eles: best }, duration: 200, easing: 'ease-out-cubic' });
}

/* ================= live data (SSE) ================= */
function setLive(on, text, err) { $('live').className = 'live' + (on ? ' on' : '') + (err ? ' err' : ''); $('live').querySelector('.txt').textContent = text; }
function banner(title, detail, err, hint) {
  $('banner').classList.toggle('show', !!title); $('banner').classList.toggle('err', !!err);
  $('bannerT').textContent = title || ''; $('bannerD').textContent = detail || '';
  $('bannerH').hidden = !hint; $('bannerH').textContent = hint || '';
}
/* cache warnings → banner: failures first (grouped by message server-side), "Đang đồng bộ: …" is just loading */
function syncBanner(w, ctx) {
  const failing = w.filter(x => !x.startsWith('Đang đồng bộ: '));
  if (!w.length) { setLive(true, 'Live'); banner(''); return; }
  if (!failing.length) { setLive(false, 'Đang đồng bộ'); banner('Đang đồng bộ với cluster…', w.join('\n')); return; }
  const all = failing.join('\n');
  const net = /timeout|timed out|connect|refused|unreachable|UnknownHost|No route|reset/i.test(all);
  const auth = /401|403|Unauthorized|Forbidden|certificate|x509|token/i.test(all);
  setLive(false, net ? 'Mất kết nối cluster' : 'Lỗi đồng bộ', true);
  banner(net ? `Không kết nối được tới cluster${ctx ? ' ' + ctx : ''}` : 'Chưa đồng bộ được với cluster',
    w.slice(0, 4).join('\n') + (w.length > 4 ? `\n… và ${w.length - 4} lỗi khác` : ''), true,
    net ? 'Kiểm tra mạng/VPN, API server còn chạy không, và firewall có cho IP hiện tại của bạn vào cổng API server không. Đang tự thử lại.'
      : auth ? 'Kiểm tra credentials/chứng chỉ trong kubeconfig và quyền RBAC của user.' : 'Đang tự thử lại.');
}
/* raw namespace choice from the select, else the URL / last session: "a", "*" or "a,b" (several ticked) */
const nsSaved = () => new URLSearchParams(location.search).get('ns') || store.get('ns') || 'default';
/* what the server is asked for: several namespaces are loaded as "*" and narrowed here (state.nsMulti) */
function currentNs() { const v = $('ns').value || nsSaved(); return v.includes(',') ? '*' : v; }
/* several namespaces ticked: Set of them (the server sends everything, nsKeep narrows it); otherwise null */
state.nsMulti = (s => (s.includes(',') ? new Set(s.split(',').filter(Boolean)) : null))(nsSaved());
const nsKeep = x => !state.nsMulti || !x.namespace || state.nsMulti.has(x.namespace);
const nsParam = () => (state.nsMulti ? [...state.nsMulti].join(',') : $('ns').value);
/* keep only the ticked namespaces (plus cluster-scoped objects, as in the all-namespaces view) and their edges */
function nsFilterGraph(g) {
  if (!state.nsMulti) return g;
  const nodes = (g.nodes || []).filter(nsKeep), ids = new Set(nodes.map(n => n.id));
  return { ...g, nodes, edges: (g.edges || []).filter(e => ids.has(e.source) && ids.has(e.target)) };
}

function fillNamespaces(list) {
  const cur = currentNs();
  const opts = list.includes(cur) || cur === '*' ? list : [cur, ...list];
  $('ns').innerHTML = `<option value="*">Tất cả namespace</option>` + opts.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  $('ns').value = cur;
}

function connect() {
  if (state.es) state.es.close();
  const ns = currentNs();
  state.first = true;
  setLive(false, 'Đang kết nối…');
  const es = state.es = new EventSource('/api/graph/stream?namespace=' + encodeURIComponent(ns));
  es.addEventListener('namespaces', e => fillNamespaces(JSON.parse(e.data)));
  state.raw = null; // a snapshot of the previous namespace must not render after the switch
  es.addEventListener('graph', e => { if (state.es !== es) return; state.raw = JSON.parse(e.data); queueGraph(); });
  // later pushes only carry what changed: every one is applied (cheap), the page is redrawn once per frame at most
  es.addEventListener('delta', e => { if (state.es !== es || !state.raw) return; state.raw = applyDelta(state.raw, JSON.parse(e.data)); queueGraph(); });
  es.onerror = () => { setLive(false, 'Mất kết nối, đang thử lại…'); if (typeof checkSession === 'function') checkSession(); };
}
/* graph pushes: rendered once per frame at most, and not at all while the tab is hidden (catches up when it shows) */
let graphScheduled = false;
function queueGraph() {
  if (graphScheduled) return;
  graphScheduled = true;
  const go = () => requestAnimationFrame(() => { graphScheduled = false; if (state.raw) applyGraph(); });
  if (!document.hidden) { go(); return; }
  const onVis = () => { if (document.hidden) return; document.removeEventListener('visibilitychange', onVis); go(); };
  document.addEventListener('visibilitychange', onVis);
}
/* a "delta" push: upserted nodes, removed ids, added / removed edges (GraphStreamer.delta). Returns a new graph object. */
function applyDelta(g, d) {
  const nodes = g.nodes.slice(), at = new Map(nodes.map((n, i) => [n.id, i]));
  d.nodes.forEach(n => { const i = at.get(n.id); if (i == null) { at.set(n.id, nodes.length); nodes.push(n); } else nodes[i] = n; });
  const gone = new Set(d.removed);
  const ek = e => e.source + '>' + e.target + '>' + e.type;
  const del = new Map(); d.edgesDel.forEach(e => del.set(ek(e), (del.get(ek(e)) || 0) + 1));
  const edges = g.edges.filter(e => { const k = ek(e), c = del.get(k); if (c) { del.set(k, c - 1); return false; } return true; }).concat(d.edgesAdd);
  return { ...g, context: d.context, warnings: d.warnings, metrics: d.metrics, nodes: gone.size ? nodes.filter(n => !gone.has(n.id)) : nodes, edges };
}
function applyGraph() {
  const raw = state.raw;
  if (typeof nsCollectStats === 'function') nsCollectStats(raw);
  const g = state.graph = nsFilterGraph(raw);
  $('ctx').querySelector('b').textContent = g.context || '—';
  if (typeof renderNodebar === 'function') renderNodebar(g);
  syncBanner(g.warnings || [], g.context);
  render(state.first);
  state.first = false;
}

$('ns').addEventListener('change', () => {
  if (!state.nsPicking) state.nsMulti = null; // ":ns x", double-click on a namespace…: back to a single one
  store.set('ns', nsParam());
  const u = new URL(location); u.searchParams.set('ns', nsParam()); history.replaceState(null, '', u);
  state.structureKey = ''; state.manual.clear(); state.podGroupsOpen.clear(); clearDetail(); connect();
});

fetch('/api/config').then(r => r.json()).then(c => {
  state.systemNs = (c.systemNamespaces || []).map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean);
  if (state.graph && isAll()) { state.structureKey = ''; render(false); }
}).catch(() => {});
clearDetail();
connect();
