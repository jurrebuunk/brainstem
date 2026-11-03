{{/* Names */}}
{{- define "brainstem.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "brainstem.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "brainstem.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "brainstem.labels" -}}
helm.sh/chart: {{ include "brainstem.chart" . }}
{{ include "brainstem.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: brainstem
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "brainstem.selectorLabels" -}}
app.kubernetes.io/name: {{ include "brainstem.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Labels for one component: (dict "root" $ "component" "api")
*/}}
{{- define "brainstem.componentLabels" -}}
{{ include "brainstem.labels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "brainstem.componentSelector" -}}
{{ include "brainstem.selectorLabels" .root }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "brainstem.image" -}}
{{- printf "%s:%s" .Values.image.repository (default (printf "v%s" .Chart.AppVersion) .Values.image.tag) }}
{{- end }}

{{- define "brainstem.modelsImage" -}}
{{- printf "%s:%s" .Values.models.image.repository .Values.models.image.tag }}
{{- end }}

{{/* Postgres in use: an URL, a secret or CloudNativePG. */}}
{{- define "brainstem.postgres" -}}
{{- if or .Values.database.url .Values.database.existingSecret .Values.cnpg.enabled }}true{{- end }}
{{- end }}

{{- define "brainstem.cnpgName" -}}
{{- printf "%s-pg" (include "brainstem.fullname" .) | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Secret (name, key) holding the database URL. */}}
{{- define "brainstem.databaseSecretName" -}}
{{- if .Values.database.existingSecret }}{{ .Values.database.existingSecret }}
{{- else if .Values.cnpg.enabled }}{{ include "brainstem.cnpgName" . }}-app
{{- else }}{{ include "brainstem.fullname" . }}-database
{{- end }}
{{- end }}

{{- define "brainstem.databaseSecretKey" -}}
{{- if .Values.database.existingSecret }}{{ .Values.database.existingSecretKey }}
{{- else if .Values.cnpg.enabled }}uri
{{- else }}url
{{- end }}
{{- end }}

{{- define "brainstem.apiTokenSecretName" -}}
{{- default (printf "%s-api-token" (include "brainstem.fullname" .)) .Values.api.token.existingSecret }}
{{- end }}

{{- define "brainstem.apiTokenSecretKey" -}}
{{- if .Values.api.token.existingSecret }}{{ .Values.api.token.existingSecretKey }}{{ else }}token{{ end }}
{{- end }}

{{- define "brainstem.configMapName" -}}
{{- default (printf "%s-config" (include "brainstem.fullname" .)) .Values.config.existingConfigMap }}
{{- end }}

{{- define "brainstem.apiUrl" -}}
{{- if eq .Values.mode "single" -}}
http://{{ include "brainstem.fullname" . }}:{{ .Values.single.port }}
{{- else -}}
http://{{ include "brainstem.fullname" . }}-api:{{ .Values.api.service.port }}
{{- end }}
{{- end }}

{{- define "brainstem.cookieSecure" -}}
{{- if kindIs "bool" .Values.api.cookieSecure }}{{ .Values.api.cookieSecure }}
{{- else if and .Values.ingress.enabled .Values.ingress.tls }}true
{{- else }}false
{{- end }}
{{- end }}

{{/*
--max-old-space-size at ~75% of a memory limit such as 512Mi or 3Gi.
*/}}
{{- define "brainstem.maxOldSpace" -}}
{{- $limit := toString (default "" .) -}}
{{- $mib := 0 -}}
{{- if hasSuffix "Gi" $limit }}{{ $mib = mul (trimSuffix "Gi" $limit | atoi) 1024 }}
{{- else if hasSuffix "Mi" $limit }}{{ $mib = trimSuffix "Mi" $limit | atoi }}
{{- else if hasSuffix "G" $limit }}{{ $mib = div (mul (trimSuffix "G" $limit | atoi) 1000000000) 1048576 }}
{{- else if hasSuffix "M" $limit }}{{ $mib = div (mul (trimSuffix "M" $limit | atoi) 1000000) 1048576 }}
{{- end -}}
{{- if gt (int $mib) 0 }}{{ div (mul $mib 3) 4 }}{{ end -}}
{{- end }}

{{/*
Environment shared by Brainstem containers.
(dict "root" $ "role" "core" "memory" "3Gi" "extra" (dict ...))
*/}}
{{- define "brainstem.env" -}}
{{- $root := .root -}}
- name: BRAINSTEM_ROLE
  value: {{ .role | quote }}
- name: BRAINSTEM_CONFIG
  value: /app/config/brainstem.config.mjs
- name: BRAINSTEM_CONFIG_SOURCE
  value: {{ $root.Values.config.source | quote }}
- name: BRAINSTEM_LOG_LEVEL
  value: {{ $root.Values.log.level | quote }}
- name: BRAINSTEM_LOG_FORMAT
  value: {{ $root.Values.log.format | quote }}
- name: POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
{{- if include "brainstem.postgres" $root }}
- name: BRAINSTEM_DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ include "brainstem.databaseSecretName" $root }}
      key: {{ include "brainstem.databaseSecretKey" $root }}
{{- end }}
{{- if not $root.Values.metrics.enabled }}
- name: BRAINSTEM_METRICS
  value: "false"
{{- else if $root.Values.metrics.token.existingSecret }}
- name: BRAINSTEM_METRICS_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ $root.Values.metrics.token.existingSecret }}
      key: {{ $root.Values.metrics.token.existingSecretKey }}
{{- end }}
{{- with $root.Values.tracing }}
{{- if .endpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ .endpoint | quote }}
- name: OTEL_TRACES_SAMPLER_ARG
  value: {{ .sampleRatio | quote }}
- name: OTEL_RESOURCE_ATTRIBUTES
  value: "k8s.namespace.name=$(POD_NAMESPACE),k8s.pod.name=$(POD_NAME),service.namespace={{ $root.Release.Name }}"
{{- if .headers }}
- name: OTEL_EXPORTER_OTLP_HEADERS
  value: {{ .headers | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- with include "brainstem.maxOldSpace" .memory }}
- name: NODE_OPTIONS
  value: "--max-old-space-size={{ . }}"
{{- end }}
{{- range $name, $value := .extra }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- range $name, $value := $root.Values.env }}
- name: {{ $name }}
  value: {{ $value | quote }}
{{- end }}
{{- with $root.Values.extraEnv }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Volumes every Brainstem pod has: config, /tmp, /app/data. */}}
{{- define "brainstem.volumes" -}}
- name: config
  configMap:
    name: {{ include "brainstem.configMapName" . }}
- name: tmp
  emptyDir: {}
{{- with .Values.extraVolumes }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{- define "brainstem.volumeMounts" -}}
- name: config
  mountPath: /app/config
  readOnly: true
- name: tmp
  mountPath: /tmp
{{- with .Values.extraVolumeMounts }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* The model: volume, mount and init container (root context). */}}
{{- define "brainstem.modelVolume" -}}
{{- if .Values.models.enabled }}
{{- if eq .Values.models.mount "imageVolume" }}
- name: models
  image:
    reference: {{ include "brainstem.modelsImage" . }}
    pullPolicy: {{ .Values.models.image.pullPolicy }}
{{- else }}
- name: models
  emptyDir:
    sizeLimit: {{ .Values.models.sizeLimit }}
{{- end }}
{{- end }}
{{- end }}

{{- define "brainstem.modelMount" -}}
{{- if .Values.models.enabled }}
- name: models
  mountPath: {{ .Values.models.path }}
  readOnly: true
{{- end }}
{{- end }}

{{- define "brainstem.modelInitContainer" -}}
{{- if and .Values.models.enabled (ne .Values.models.mount "imageVolume") }}
- name: models
  image: {{ include "brainstem.modelsImage" . }}
  imagePullPolicy: {{ .Values.models.image.pullPolicy }}
  command: ["sh", "-c", "cp -r /models/. /shared/ && ls -la /shared"]
  securityContext:
    {{- toYaml .Values.securityContext | nindent 4 }}
  resources:
    requests: { cpu: 50m, memory: 64Mi }
    limits: { memory: 256Mi }
  volumeMounts:
    - name: models
      mountPath: /shared
{{- end }}
{{- end }}

{{- define "brainstem.topologySpread" -}}
{{- if .root.Values.topologySpread.enabled }}
topologySpreadConstraints:
  - maxSkew: {{ .root.Values.topologySpread.maxSkew }}
    topologyKey: kubernetes.io/hostname
    whenUnsatisfiable: {{ .root.Values.topologySpread.whenUnsatisfiable }}
    labelSelector:
      matchLabels:
        {{- .selector | nindent 8 }}
  - maxSkew: {{ .root.Values.topologySpread.maxSkew }}
    topologyKey: topology.kubernetes.io/zone
    whenUnsatisfiable: ScheduleAnyway
    labelSelector:
      matchLabels:
        {{- .selector | nindent 8 }}
{{- end }}
{{- end }}

{{- define "brainstem.serviceAccountName" -}}
{{- if .root.Values.serviceAccount.create }}{{ include "brainstem.fullname" .root }}-{{ .component }}{{ else }}default{{ end }}
{{- end }}

{{/* Fail early on configurations that cannot work. */}}
{{- define "brainstem.validate" -}}
{{- if not (has .Values.mode (list "single" "cluster")) }}
{{- fail "mode must be single or cluster" }}
{{- end }}
{{- if not (has .Values.config.source (list "database" "file")) }}
{{- fail "config.source must be database or file" }}
{{- end }}
{{- if and (eq .Values.mode "cluster") (not (include "brainstem.postgres" .)) }}
{{- fail "cluster mode needs Postgres: set database.url, database.existingSecret or cnpg.enabled" }}
{{- end }}
{{- if and .Values.database.url .Values.database.existingSecret }}
{{- fail "set database.url or database.existingSecret, not both" }}
{{- end }}
{{- if and .Values.cnpg.enabled (or .Values.database.url .Values.database.existingSecret) }}
{{- fail "cnpg.enabled creates the database: leave database.url and database.existingSecret empty" }}
{{- end }}
{{- if not (has .Values.models.mount (list "initContainer" "imageVolume")) }}
{{- fail "models.mount must be initContainer or imageVolume" }}
{{- end }}
{{- end }}
