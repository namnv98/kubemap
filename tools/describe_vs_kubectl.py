#!/usr/bin/env python3
"""Compare Kubemap /api/describe (app on localhost:8080) with `kubectl describe`, line by line.
Run against the cluster the app is connected to, with tools/testdata/*.yaml applied.
usage: cmp.py KIND NS NAME [-v]   (NS '-' for cluster-scoped); or cmp.py --all"""
import difflib, json, os, re, subprocess, sys, urllib.parse, urllib.request

KCFG = os.environ.get('KUBECONFIG', os.path.expanduser('~/.kube/config'))  # same cluster the app is connected to
RES = {'Pod': 'pod', 'Deployment': 'deployment', 'ReplicaSet': 'replicaset', 'StatefulSet': 'statefulset',
       'DaemonSet': 'daemonset', 'Job': 'job', 'CronJob': 'cronjob', 'Service': 'service', 'Ingress': 'ingress',
       'ConfigMap': 'configmap', 'Secret': 'secret', 'PersistentVolumeClaim': 'pvc', 'PersistentVolume': 'pv',
       'Node': 'node', 'HorizontalPodAutoscaler': 'hpa', 'Role': 'role', 'RoleBinding': 'rolebinding',
       'ClusterRole': 'clusterrole', 'ServiceAccount': 'serviceaccount', 'HelmChart': 'helmchart.helm.cattle.io'}


def app(kind, ns, name):
    q = {'kind': kind, 'name': name}
    if ns != '-': q['namespace'] = ns
    with urllib.request.urlopen('http://localhost:8080/api/describe?' + urllib.parse.urlencode(q)) as r:
        return json.load(r)['text']


def kubectl(kind, ns, name):
    cmd = ['kubectl', '--kubeconfig', KCFG, 'describe', RES[kind], name] + ([] if ns == '-' else ['-n', ns])
    return subprocess.run(cmd, capture_output=True, text=True, check=True).stdout


def compare(kind, ns, name, verbose):
    a, k = app(kind, ns, name).rstrip('\n').split('\n'), kubectl(kind, ns, name).rstrip('\n').split('\n')
    # app and kubectl run a moment apart: ages ("7m51s", "x262 over 72m") and lease renew times may differ by a second
    age = re.compile(r'\b\d+[smhdy](\d+[smh])?\b|\b\d\d:\d\d:\d\d\b')
    norm = lambda lines: [age.sub('~', l) for l in lines]
    sm = difflib.SequenceMatcher(None, norm(k), norm(a), autojunk=False)
    same = sum(b.size for b in sm.get_matching_blocks())
    total = max(len(k), len(a))  # lines missing on either side count as different
    print(f'{kind:24} {ns + "/" + name if ns != "-" else name:48} {same}/{total} dòng giống ({100 * same // max(1, total)}%)  [kubectl {len(k)} / app {len(a)}]')
    if verbose:
        for line in difflib.unified_diff(k, a, 'kubectl', 'app', n=0, lineterm=''):
            print('   ', line)
    return same, total


SAMPLES = [
    ('Pod', 'shop', None, 'app=api'), ('Deployment', 'shop', 'api', None), ('Deployment', 'shop', 'frontend', None),
    ('ReplicaSet', 'shop', None, 'app=api'), ('StatefulSet', 'shop', 'postgres', None), ('StatefulSet', 'messaging', 'nats', None),
    ('DaemonSet', 'observability', 'node-exporter', None), ('Job', 'batch', 'migrate-v42', None), ('Job', 'batch', 'import-broken', None),
    ('CronJob', 'batch', 'report', None), ('Service', 'shop', 'frontend', None), ('Service', 'shop-staging', 'api', None),
    ('Service', 'auth', 'identity-provider', None), ('Ingress', 'shop', 'shop', None), ('Ingress', 'auth', 'whoami', None),
    ('ConfigMap', 'shop', 'frontend-config', None), ('Secret', 'shop', 'api-db', None), ('PersistentVolumeClaim', 'shop', 'data-postgres-0', None),
    ('PersistentVolumeClaim', 'payments', 'archive', None), ('Node', '-', 'k3s-worker-1', None), ('HorizontalPodAutoscaler', 'shop', 'frontend', None),
    ('Role', 'auth', 'secret-reader', None), ('RoleBinding', 'auth', 'auth-operator-secret-reader', None), ('ClusterRole', '-', 'prometheus-read', None),
    ('ServiceAccount', 'shop', 'api', None), ('Pod', 'payments', None, 'app=gateway'), ('Pod', 'payments', None, 'app=ledger'),
    ('Pod', 'payments', None, 'app=fraud-model'), ('Pod', 'blog', None, 'app=web'), ('HelmChart', 'kube-system', 'traefik', None),
]


def first(kind, ns, sel):
    out = subprocess.run(['kubectl', '--kubeconfig', KCFG, 'get', RES[kind], '-n', ns, '-l', sel, '-o', 'name'],
                         capture_output=True, text=True, check=True).stdout.split()
    return out[0].split('/', 1)[1]


if __name__ == '__main__':
    v = '-v' in sys.argv
    args = [a for a in sys.argv[1:] if a != '-v']
    if args and args[0] != '--all':
        compare(*args[:3], v)
    else:
        tot = [0, 0]
        for kind, ns, name, sel in SAMPLES:
            try:
                s, n = compare(kind, ns, name or first(kind, ns, sel), v)
                tot[0] += s; tot[1] += n
            except Exception as e:
                print(f'{kind:24} {ns}/{name or sel}: LỖI {e}')
        print(f'TỔNG: {tot[0]}/{tot[1]} ({100 * tot[0] // tot[1]}%)')
