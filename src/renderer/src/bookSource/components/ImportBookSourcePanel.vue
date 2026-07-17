<script setup lang="ts">
import { computed, ref, watch } from "vue";
import AppModal from "../../components/AppModal.vue";
import AppCheckbox from "../../components/AppCheckbox.vue";
import IconButton from "../../components/IconButton.vue";
import { icons } from "../../icons";
import EditBookSourcePanel from "./EditBookSourcePanel.vue";
import { useBookSourceApi } from "../composables/useBookSource";
import type {
  BookSourceImportPreviewItem,
  BookSourceRecord,
} from "@shared/bookSource/types";

const emit = defineEmits<{
  done: [];
}>();

const modelValue = defineModel<boolean>({ default: false });
const items = defineModel<BookSourceImportPreviewItem[]>("items", {
  default: () => [],
});
const { commitImport } = useBookSourceApi();

const selected = ref<Set<number>>(new Set());
const showEdit = ref(false);
const editIndex = ref(0);

const total = computed(() => items.value.length);
const selectedCount = computed(() => selected.value.size);
const allSelected = computed(
  () => items.value.length > 0 && selected.value.size === items.value.length,
);
const selectAllLabel = computed(() => (allSelected.value ? "取消全选" : "全选"));
const selectAllIndeterminate = computed(
  () => selectedCount.value > 0 && !allSelected.value,
);

function defaultSelectedIndices(items: BookSourceImportPreviewItem[]): Set<number> {
  return new Set(
    items
      .map((item, i) => (item.status === "new" || item.status === "update" ? i : -1))
      .filter((i) => i >= 0),
  );
}

watch(
  items,
  (list, prev) => {
    const structuralChange =
      !prev ||
      list.length !== prev.length ||
      list.some(
        (it, i) => it.source.bookSourceUrl !== prev[i]?.source.bookSourceUrl,
      );
    if (structuralChange) {
      selected.value = defaultSelectedIndices(list);
    }
  },
  { immediate: true },
);

function statusLabel(status: BookSourceImportPreviewItem["status"]) {
  if (status === "new") return "新增";
  if (status === "update") return "更新";
  return "已有";
}

function toggle(idx: number) {
  const next = new Set(selected.value);
  if (next.has(idx)) next.delete(idx);
  else next.add(idx);
  selected.value = next;
}

function onRowClick(index: number) {
  toggle(index);
}

function selectAll() {
  selected.value = new Set(items.value.map((_, i) => i));
}

function clearSelection() {
  selected.value = new Set();
}

function onToggleSelectAll(checked: boolean) {
  if (checked) selectAll();
  else clearSelection();
}

function selectNew() {
  selected.value = new Set(
    items.value.map((item, i) => (item.status === "new" ? i : -1)).filter((i) => i >= 0),
  );
}

function selectUpdate() {
  selected.value = new Set(
    items.value
      .map((item, i) => (item.status === "update" ? i : -1))
      .filter((i) => i >= 0),
  );
}

function onEdit(idx: number) {
  editIndex.value = idx;
  showEdit.value = true;
}

function onEditDone(source: BookSourceRecord) {
  showEdit.value = false;
  const idx = editIndex.value;
  const prev = items.value[idx];
  if (!prev) return;
  const next = items.value.slice();
  next[idx] = { ...prev, source };
  items.value = next;
}

async function onConfirm() {
  const indices = [...selected.value];
  if (!indices.length) return;
  const addUrls: string[] = [];
  const updateUrls: string[] = [];
  const sources: BookSourceImportPreviewItem["source"][] = [];
  for (const i of indices) {
    const item = items.value[i];
    if (!item) continue;
    sources.push(item.source);
    if (item.status === "new") addUrls.push(item.source.bookSourceUrl);
    else if (item.status === "update") updateUrls.push(item.source.bookSourceUrl);
  }
  await commitImport({ addUrls, updateUrls, sources });
  modelValue.value = false;
  emit("done");
}

function onCancel() {
  modelValue.value = false;
}
</script>

<template>
  <AppModal
    v-model="modelValue"
    title="导入书源"
    panel-class="bookSourcePanel"
    :mask-closable="false"
    :esc-closable="true"
    :body-scroll="false"
  >
    <div class="bsShell">
      <p class="impHint">说明：只显示「文本」类型的书源</p>
      <ul class="bsList">
        <li
          v-for="(item, index) in items"
          :key="item.source.bookSourceUrl"
          class="bsRow"
          @click="onRowClick(index)"
        >
          <AppCheckbox
            class="bsRowCheckbox"
            passive
            :model-value="selected.has(index)"
            :aria-label="`选择 ${item.source.bookSourceName}`"
          />
          <div class="bsRowMain">
            <div class="bsRowName">{{ item.source.bookSourceName }}</div>
          </div>
          <div class="bsRowActions" @click.stop>
            <span class="impTag" :data-status="item.status">
              {{ statusLabel(item.status) }}
            </span>
            <IconButton
              :icon-html="icons.edit"
              title="编辑"
              aria-label="编辑"
              @click="onEdit(index)"
            />
          </div>
        </li>
      </ul>
    </div>

    <template #footer>
      <div class="bsFooter">
        <AppCheckbox
          class="bsFooterSelectAll"
          :model-value="allSelected"
          :indeterminate="selectAllIndeterminate"
          :aria-label="selectAllLabel"
          @update:model-value="onToggleSelectAll"
        >
          <template #label>
            {{ selectAllLabel }}（{{ selectedCount }}/{{ total }}）
          </template>
        </AppCheckbox>
        <div class="bsFooterActions">
          <button type="button" class="btn bsFooterBtn" size="large" @click="selectNew">
            选中新增
          </button>
          <button type="button" class="btn bsFooterBtn" size="large" @click="selectUpdate">
            选中更新
          </button>
          <button type="button" class="btn bsFooterBtn" size="large" @click="onCancel">
            取消
          </button>
          <button
            type="button"
            class="btn primary bsFooterBtn"
            size="large"
            :disabled="!selectedCount"
            @click="onConfirm"
          >
            导入
          </button>
        </div>
      </div>
    </template>

    <EditBookSourcePanel
      v-model="showEdit"
      :draft-source="items[editIndex]?.source"
      draft-only
      @done="onEditDone"
    />
  </AppModal>
</template>

<style scoped>
.bsShell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.impHint {
  margin: 0;
  padding: 0 16px 10px;
  font-size: 12px;
  line-height: 1.4;
  color: var(--muted);
  flex-shrink: 0;
  border-bottom: 1px solid var(--border, rgba(0, 0, 0, 0.08));
}
.bsList {
  flex: 1;
  min-height: 0;
  min-width: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow: auto;
  background: var(--bg);
}
.bsRow {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  min-height: 50px;
  padding: 6px 0;
  border-bottom: 1px solid var(--border);
  user-select: none;
}
.bsRowCheckbox {
  flex-shrink: 0;
  pointer-events: none;
}
.bsRowActions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.bsRowMain {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
.bsRowName {
  /* font-weight: 600; */
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.impTag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  flex-shrink: 0;
  background: var(--list-item-bg-hover, rgba(0, 0, 0, 0.06));
  color: var(--muted);
}
.impTag[data-status="new"] {
  background: color-mix(in srgb, #43a047 18%, transparent);
  color: #43a047;
}
.impTag[data-status="update"] {
  background: color-mix(in srgb, #ef6c00 18%, transparent);
  color: #ef6c00;
}
.bsFooter {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
.bsFooterSelectAll {
  font-size: 14px;
  color: var(--fg, #333);
}
.bsFooterSelectAll :deep(.appCheckbox__label) {
  font-size: 14px;
  color: var(--fg, #333);
}
.bsFooterActions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}
.bsFooterBtn {
  justify-content: center;
  line-height: 1;
}
</style>
