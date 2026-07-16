<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import AppModal from "../../components/AppModal.vue";
import IconButton from "../../components/IconButton.vue";
import SwitchToggle from "../../components/SwitchToggle.vue";
import AppCheckbox from "../../components/AppCheckbox.vue";
import AutoResizeTextarea from "../../components/AutoResizeTextarea.vue";
import AppShellMenuTeleport from "../../components/AppShellMenuTeleport.vue";
import { useAnchoredAppShellMenu } from "../../composables/useAnchoredAppShellMenu";
import {
  SORTABLE_ROW_HANDLE_CLASS,
  useSortableReorder,
} from "../../composables/useSortableReorder";
import { icons } from "../../icons";
import {
  displayReplaceRuleName,
  isReplaceRuleValid,
  parseReplaceRuleJson,
  replaceRuleForExport,
  replaceRulesChangedEventFor,
  type ReplaceRule,
  type ReplaceRuleBucket,
} from "@shared/bookSource/replaceRule";
import {
  commitReplaceRulesLocal,
  listReplaceRulesLocal,
} from "../replaceRuleLocalStore";
import { appPrompt } from "../../services/appDialog";
import { appToast } from "../../services/appToast";

const modelValue = defineModel<boolean>({ default: false });

const props = withDefaults(
  defineProps<{
    /** 主窗口 / 找书分键；默认找书 */
    bucket?: ReplaceRuleBucket;
    /**
     * 编辑态「格式化：文本替换」：主按钮为「应用」=
     * 保存规则后由父级写入当前编辑缓冲区。
     */
    editFormatMode?: boolean;
  }>(),
  { bucket: "findBook", editFormatMode: false },
);

const emit = defineEmits<{
  /** 编辑态点「应用」：规则已 commit，父级应对 Monaco 套用正文替换 */
  applyFormat: [rules: ReplaceRule[]];
}>();

function notifyReplaceRulesChanged() {
  window.dispatchEvent(new Event(replaceRulesChangedEventFor(props.bucket)));
}

/** 编辑草稿 */
type ReplaceRuleEditDraft = ReplaceRule;

const items = ref<ReplaceRule[]>([]);
const showEdit = ref(false);
const editing = ref<ReplaceRuleEditDraft | null>(null);
const editingRuleId = ref<number | null>(null);
const saving = ref(false);

function cloneRule(r: ReplaceRule): ReplaceRule {
  return { ...r };
}

const headerMoreBtnRef = ref<HTMLElement | null>(null);
const headerMoreMenu = useAnchoredAppShellMenu({
  anchor: headerMoreBtnRef,
  placement: "below-end",
  widthPx: 180,
});
const {
  open: headerMoreOpen,
  left: headerMoreLeft,
  top: headerMoreTop,
  toggleMenu: toggleHeaderMoreMenu,
  closeMenu: closeHeaderMoreMenu,
  panelRef: headerMorePanelRef,
} = headerMoreMenu;

function bindHeaderMorePanel(el: HTMLElement | null) {
  headerMorePanelRef.value = el;
}

const ruleTableBodyRef = ref<HTMLElement | null>(null);
const tableBodyScrollRef = ref<HTMLElement | null>(null);
const headScrollbarPadPx = ref(0);
const ruleCount = computed(() => items.value.length);
const hasEnabledRules = computed(() =>
  items.value.some((r) => r.isEnabled),
);
let tableBodyScrollRo: ResizeObserver | null = null;

const ruleTableHeadPadStyle = computed(() =>
  headScrollbarPadPx.value > 0
    ? { paddingRight: `${headScrollbarPadPx.value}px` }
    : undefined,
);

function syncRuleTableHeadScrollbarPad() {
  const el = tableBodyScrollRef.value;
  headScrollbarPadPx.value = el ? el.offsetWidth - el.clientWidth : 0;
}

function teardownRuleTableBodyScrollRo() {
  tableBodyScrollRo?.disconnect();
  tableBodyScrollRo = null;
}

function ensureRuleTableBodyScrollRo() {
  teardownRuleTableBodyScrollRo();
  const el = tableBodyScrollRef.value;
  if (!el) {
    headScrollbarPadPx.value = 0;
    return;
  }
  syncRuleTableHeadScrollbarPad();
  if (typeof ResizeObserver === "undefined") return;
  tableBodyScrollRo = new ResizeObserver(syncRuleTableHeadScrollbarPad);
  tableBodyScrollRo.observe(el);
}

const editModalTitle = computed(() =>
  editingRuleId.value == null ? "新增替换规则" : "编辑替换规则",
);

function loadLocalRules() {
  items.value = listReplaceRulesLocal(props.bucket).map(cloneRule);
}

watch(modelValue, (open) => {
  if (open) {
    loadLocalRules();
    void nextTick(ensureRuleTableBodyScrollRo);
    return;
  }
  closeHeaderMoreMenu();
  teardownRuleTableBodyScrollRo();
  headScrollbarPadPx.value = 0;
});

// sync：先于主 AppModal 的注销，先关掉子级编辑弹框
watch(
  modelValue,
  (open) => {
    if (!open) showEdit.value = false;
  },
  { flush: "sync" },
);

watch(ruleCount, () => {
  void nextTick(syncRuleTableHeadScrollbarPad);
});

onBeforeUnmount(teardownRuleTableBodyScrollRo);

useSortableReorder({
  containerRef: ruleTableBodyRef,
  active: modelValue,
  itemCount: ruleCount,
  enabled: computed(() => items.value.length > 1),
  onReorder(from, to) {
    moveRule(from, to);
  },
});

function close() {
  modelValue.value = false;
}

function applyRules() {
  if (saving.value) return;
  saving.value = true;
  try {
    const payload = items.value.map((r, i) => ({
      ...r,
      order: i,
    }));
    const committed = commitReplaceRulesLocal(props.bucket, payload);
    items.value = committed.map(cloneRule);
    notifyReplaceRulesChanged();
    if (props.editFormatMode) {
      emit("applyFormat", committed);
    }
    close();
  } finally {
    saving.value = false;
  }
}

function onToggle(item: ReplaceRule, enabled: boolean) {
  const idx = items.value.findIndex((r) => r.id === item.id);
  if (idx < 0) return;
  items.value[idx] = { ...items.value[idx]!, isEnabled: enabled };
}

function openCreate() {
  closeHeaderMoreMenu();
  editingRuleId.value = null;
  editing.value = {
    id: Date.now(),
    name: "",
    group: "",
    pattern: "",
    replacement: "",
    scope: "",
    scopeTitle: false,
    scopeContent: true,
    excludeScope: "",
    isEnabled: true,
    isRegex: false,
    timeoutMillisecond: 3000,
    order: Number.MIN_SAFE_INTEGER,
  };
  showEdit.value = true;
}

function openEdit(item: ReplaceRule) {
  editingRuleId.value = item.id;
  editing.value = {
    ...item,
    scope: item.scope ?? "",
    excludeScope: item.excludeScope ?? "",
  };
  showEdit.value = true;
}

function onSaveEdit() {
  const draft = editing.value;
  if (!draft) return;
  if (!isReplaceRuleValid(draft)) {
    appToast("请填写有效的替换规则（正则语法须正确）", { kind: "warning" });
    return;
  }
  const payload: ReplaceRule = { ...draft };
  if (editingRuleId.value == null) {
    let id = payload.id;
    while (items.value.some((r) => r.id === id)) id += 1;
    items.value = [...items.value, { ...payload, id }];
  } else {
    const idx = items.value.findIndex((r) => r.id === editingRuleId.value);
    if (idx >= 0) {
      items.value[idx] = { ...payload, id: editingRuleId.value };
    }
  }
  showEdit.value = false;
  editing.value = null;
  editingRuleId.value = null;
}

function onEnableAll(enabled: boolean) {
  items.value = items.value.map((r) => ({ ...r, isEnabled: enabled }));
}

function mergeImportedRules(rules: ReplaceRule[]): number {
  const next = [...items.value];
  const seen = new Set(next.map((x) => x.id));
  let added = 0;
  for (const raw of rules) {
    let id = raw.id;
    while (seen.has(id)) id += 1;
    seen.add(id);
    next.push({ ...raw, id });
    added += 1;
  }
  items.value = next;
  return added;
}

async function onImportFile() {
  closeHeaderMoreMenu();
  const r = await window.colorTxt.showOpenDialog({
    properties: ["openFile"],
    filters: [
      { name: "JSON", extensions: ["json"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (r.canceled || !r.filePaths.length) return;
  const read = await window.colorTxt.bookSourceReadFile(r.filePaths[0]!);
  if (!read.ok || !read.text) {
    appToast(read.message || "读取失败", { kind: "warning" });
    return;
  }
  const rules = parseReplaceRuleJson(read.text);
  if (!rules.length) {
    appToast("未解析到有效替换规则", { kind: "warning" });
    return;
  }
  const added = mergeImportedRules(rules);
  appToast(
    `已加入 ${added} 条（${props.editFormatMode ? "应用" : "保存"}后生效）`,
    { kind: "info" },
  );
}

async function onNetworkImport() {
  closeHeaderMoreMenu();
  const url = await appPrompt("", {
    title: "网络导入",
    placeholder: "URL",
  });
  if (!url?.trim()) return;
  const res = await window.colorTxt.bookSourceFetchUrl(url.trim());
  if (!res.ok || !res.text) {
    appToast(res.message || "加载失败", { kind: "warning" });
    return;
  }
  const rules = parseReplaceRuleJson(res.text);
  if (!rules.length) {
    appToast("未解析到有效替换规则", { kind: "warning" });
    return;
  }
  const added = mergeImportedRules(rules);
  appToast(
    `已加入 ${added} 条（${props.editFormatMode ? "应用" : "保存"}后生效）`,
    { kind: "info" },
  );
}

async function onExportEnabled() {
  closeHeaderMoreMenu();
  const enabled = items.value.filter((r) => r.isEnabled);
  if (!enabled.length) {
    appToast("没有已启用的规则可导出", { kind: "warning" });
    return;
  }
  const save = await window.colorTxt.showSaveDialog({
    title: "导出启用规则",
    defaultPath: "replaceRule.json",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (save.canceled || !save.filePath) return;
  const body = `${JSON.stringify(enabled.map(replaceRuleForExport), null, 2)}\n`;
  const written = await window.colorTxt.writeTextFile(save.filePath, body, "utf8");
  if (!written.ok) {
    appToast(written.message || "导出失败", { kind: "warning" });
    return;
  }
  appToast(`已导出 ${enabled.length} 条替换规则`, { kind: "success" });
}

function onDeleteOne(item: ReplaceRule) {
  items.value = items.value.filter((r) => r.id !== item.id);
}

function moveRule(fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return;
  const arr = [...items.value];
  const [item] = arr.splice(fromIndex, 1);
  if (!item) return;
  arr.splice(toIndex, 0, item);
  items.value = arr;
}

function flattenPreviewText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, " ");
}

function ruleReplacePreview(item: ReplaceRule): string {
  const from = flattenPreviewText(item.pattern?.trim() || "");
  const to = flattenPreviewText(item.replacement ?? "");
  return `${from} → ${to}`;
}
</script>

<template>
  <AppModal
    v-model="modelValue"
    title="文本替换"
    max-width="680px"
    :mask-closable="false"
    :esc-closable="true"
  >
    <div class="descRow">
      <p class="desc">
        可启用多条规则，按顺序依次替换正文或标题中的匹配内容。拖动操作列的「移动」图标调整优先级。
      </p>
      <div ref="headerMoreBtnRef" class="descMoreWrap">
        <IconButton
          :icon-html="icons.more"
          title="更多"
          aria-label="更多"
          @click="toggleHeaderMoreMenu"
        />
        <AppShellMenuTeleport
          v-model:open="headerMoreOpen"
          :left="headerMoreLeft"
          :top="headerMoreTop"
          :on-panel-mount="bindHeaderMorePanel"
        >
          <button
            type="button"
            class="appShellMenuItem"
            role="menuitem"
            @click="onImportFile"
          >
            <span class="appShellMenuLabel">本地导入</span>
          </button>
          <button
            type="button"
            class="appShellMenuItem"
            role="menuitem"
            @click="onNetworkImport"
          >
            <span class="appShellMenuLabel">网络导入</span>
          </button>
          <button
            type="button"
            class="appShellMenuItem"
            role="menuitem"
            :disabled="!hasEnabledRules"
            @click="onExportEnabled"
          >
            <span class="appShellMenuLabel">导出当前启用的规则</span>
          </button>
        </AppShellMenuTeleport>
      </div>
    </div>

    <div class="tableWrap">
      <div class="ruleTableHeadWrap" :style="ruleTableHeadPadStyle">
        <table class="ruleTable ruleTable--head">
          <colgroup>
            <col class="colCheck" />
            <col class="colRule" />
            <col class="colActions" />
          </colgroup>
          <thead>
            <tr>
              <th class="colCheck" scope="col" aria-label="启用"></th>
              <th class="colRule" scope="col">替换规则</th>
              <th class="colActions" scope="col">操作</th>
            </tr>
          </thead>
        </table>
      </div>
      <div ref="tableBodyScrollRef" class="tableBodyScroll">
        <div v-if="!items.length" class="emptyHint">暂无替换规则</div>
        <table v-else class="ruleTable ruleTable--body">
          <colgroup>
            <col class="colCheck" />
            <col class="colRule" />
            <col class="colActions" />
          </colgroup>
          <tbody ref="ruleTableBodyRef">
            <tr v-for="item in items" :key="item.id">
              <td class="cellCheck">
                <SwitchToggle
                  :model-value="item.isEnabled"
                  size="sm"
                  :aria-label="`启用规则 ${displayReplaceRuleName(item)}`"
                  @update:model-value="onToggle(item, $event)"
                />
              </td>
              <td class="cellRule">
                <div class="ruleTitle">{{ displayReplaceRuleName(item) }}</div>
                <div class="rulePreview" :title="ruleReplacePreview(item)">
                  {{ ruleReplacePreview(item) }}
                </div>
              </td>
              <td class="cellActions">
                <div class="cellActionsInner">
                  <IconButton
                    :class="SORTABLE_ROW_HANDLE_CLASS"
                    :icon-html="icons.move"
                    aria-label="拖动排序"
                    title="拖动排序"
                    :disabled="items.length <= 1"
                  />
                  <IconButton
                    :icon-html="icons.edit"
                    aria-label="编辑"
                    title="编辑"
                    @click="openEdit(item)"
                  />
                  <IconButton
                    :icon-html="icons.remove"
                    aria-label="删除"
                    title="删除"
                    @click="onDeleteOne(item)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <template #footer>
      <div class="replaceRuleFooter">
        <div class="replaceRuleFooterStart">
          <button class="btn" type="button" size="large" @click="openCreate">
            添加替换规则
          </button>
          <button
            class="btn"
            type="button"
            size="large"
            :disabled="!items.length"
            @click="onEnableAll(true)"
          >
            全部启用
          </button>
          <button
            class="btn"
            type="button"
            size="large"
            :disabled="!items.length"
            @click="onEnableAll(false)"
          >
            全部禁用
          </button>
        </div>
        <div class="replaceRuleFooterEnd">
          <button class="btn" type="button" size="large" @click="close">
            关闭
          </button>
          <button
            class="btn primary"
            type="button"
            size="large"
            :disabled="saving"
            @click="applyRules"
          >
            {{ editFormatMode ? "应用" : "保存" }}
          </button>
        </div>
      </div>
    </template>
  </AppModal>

  <AppModal
    v-model="showEdit"
    :title="editModalTitle"
    panel-class="editReplaceRulePanel"
    :mask-closable="false"
    :esc-closable="true"
    :body-scroll="false"
  >
    <div v-if="editing" class="editShell">
      <div class="editFields">
        <label class="editField">
          <span class="editFieldLabel">
            <span class="editFieldLabelTitle">名称</span>
            <span class="editFieldLabelKey">（可选）</span>
          </span>
          <AutoResizeTextarea
            class="editFieldInput"
            v-model="editing.name"
          />
        </label>
        <label class="editField">
          <span class="editFieldLabel">
            <span class="editFieldLabelTitle">替换规则</span>
          </span>
          <AutoResizeTextarea
            class="editFieldInput"
            v-model="editing.pattern"
          />
        </label>
        <div class="editCheckRow">
          <AppCheckbox class="editCheck" v-model="editing.isRegex" label="使用正则表达式" />
        </div>
        <label class="editField">
          <span class="editFieldLabel">
            <span class="editFieldLabelTitle">替换为</span>
            <span class="editFieldLabelKey">（可选）</span>
          </span>
          <AutoResizeTextarea
            class="editFieldInput"
            v-model="editing.replacement"
          />
        </label>
        <div class="editCheckRow editCheckRow--pair">
          <AppCheckbox class="editCheck" v-model="editing.scopeTitle" label="作用于标题" />
          <AppCheckbox class="editCheck" v-model="editing.scopeContent" label="作用于正文" />
        </div>
        <template v-if="bucket === 'findBook'">
          <label class="editField">
            <span class="editFieldLabel">
              <span class="editFieldLabelTitle">替换范围</span>
              <span class="editFieldLabelKey">（可选）</span>
            </span>
            <AutoResizeTextarea
              class="editFieldInput"
              v-model="editing.scope"
              placeholder="书名或书源 URL"
            />
          </label>
          <label class="editField">
            <span class="editFieldLabel">
              <span class="editFieldLabelTitle">排除范围</span>
              <span class="editFieldLabelKey">（可选）</span>
            </span>
            <AutoResizeTextarea
              class="editFieldInput"
              v-model="editing.excludeScope"
              placeholder="书名或书源 URL"
            />
          </label>
        </template>
      </div>
    </div>
    <template #footer>
      <div class="editFooter">
        <div class="editFooterActions">
          <button
            type="button"
            class="btn"
            size="large"
            @click="showEdit = false"
          >
            取消
          </button>
          <button
            type="button"
            class="btn primary"
            size="large"
            @click="onSaveEdit"
          >
            确定
          </button>
        </div>
      </div>
    </template>
  </AppModal>
</template>

<style>
.editReplaceRulePanel {
  overflow: hidden;
}
.editReplaceRulePanel .appModalBody {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>

<style scoped>
.descRow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 10px;
}

.desc {
  margin: 0;
  flex: 1;
  min-width: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--muted);
}

.descMoreWrap {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
}

.tableWrap {
  display: flex;
  flex-direction: column;
  max-height: min(50vh, 420px);
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg);
  overflow: hidden;
}

.ruleTableHeadWrap {
  flex-shrink: 0;
}

.tableBodyScroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

.emptyHint {
  padding: 36px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--muted);
}

.ruleTable {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  table-layout: fixed;
}

.ruleTable col.colCheck {
  width: 44px;
}

.ruleTable col.colActions {
  width: 118px;
}

.ruleTable th,
.ruleTable td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}

.ruleTable--head th {
  text-align: left;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  background: color-mix(in srgb, var(--bg) 92%, var(--border));
}

.ruleTable--body tbody tr:last-child td {
  border-bottom: none;
}

.cellCheck {
  text-align: center;
}

.cellRule {
  min-width: 0;
}

.ruleTitle {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rulePreview {
  margin-top: 4px;
  font-size: 12px;
  line-height: 1.45;
  font-family: Consolas, "Courier New", monospace;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cellActions {
  vertical-align: middle;
  text-align: left;
}

.cellActionsInner {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 4px;
}

.replaceRuleFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  width: 100%;
}

.replaceRuleFooterStart {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.replaceRuleFooterEnd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-left: auto;
}

:deep(tr.sortableRowGhost) {
  opacity: 0.45;
}

:deep(tr.sortableRowChosen) {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

:deep(.sortableRowHandle) {
  cursor: grab;
}

:deep(.sortableRowHandle:active) {
  cursor: grabbing;
}

.editShell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.editFields {
  flex: 1;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 10px 0;
}
.editField {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.editFieldLabel {
  font-size: 12px;
  line-height: 1.4;
}
.editFieldLabelTitle {
  font-weight: 600;
  color: var(--fg);
}
.editFieldLabelKey {
  font-weight: 400;
  color: var(--muted);
}
.editFieldInput {
  width: 100%;
}
.editCheckRow {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-top: -15px;
}
.editCheckRow--pair {
  flex-wrap: wrap;
}
.editCheck {
  font-size: 12px;
}
.editFooter {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  width: 100%;
  min-width: 0;
}
.editFooterActions {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
</style>
