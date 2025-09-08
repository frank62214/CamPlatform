<script setup lang="ts">
// import CameraView from "./CameraView.vue";
import RecordView from "./RecordView.vue";
import { ref, watch } from "vue";
import axios from "axios";
type TabType = "realtime" | "history";
const activeTab = ref<TabType>("realtime");

// API 回來的資料格式
// interface HistoryRecord {
//     id: string
//     timeStamp: string
//     fileUrl: string
// }

interface HistoryRecordFolder {
    id: string
    date: string
    file: string[]
}
const cam1historyList = ref<HistoryRecordFolder[]>([]);
// 歷史資料列表
const cam2historyList = ref<HistoryRecordFolder[]>([]);

// 模擬 API 呼叫 (你可以改成自己的後端 API)
async function fetchHistory() {
    try {
        const resCam1 = await axios.get("/api/cam1/records");
        cam1historyList.value = resCam1.data as HistoryRecordFolder[];
        console.log(cam1historyList.value[cam1historyList.value.length -1].file);
        const resCam2 = await axios.get("/api/cam2/records");
        cam2historyList.value = resCam2.data as HistoryRecordFolder[];
    } catch (err) {
        console.error("取得歷史影像失敗:", err);
    }
}

// 當切換到 "history" 時才去打 API
watch(activeTab, (newVal) => {
    if (newVal === "history") {
        fetchHistory();
    }
});

</script>

<template>
    <div class="container mt-4">
        <!-- Tabs -->
        <ul class="nav nav-tabs">
            <li class="nav-item">
                <button class="nav-link" :class="{ active: activeTab === 'realtime' }" @click="activeTab = 'realtime'">
                    即時影像
                </button>
            </li>
            <li class="nav-item">
                <button class="nav-link" :class="{ active: activeTab === 'history' }" @click="activeTab = 'history'">
                    歷史影像
                </button>
            </li>
        </ul>

        <!-- Tab Content -->
        <div class="tab-content mt-3">
            <!-- 即時影像 -->
            <div class="tab-pane fade" :class="{ show: activeTab === 'realtime', active: activeTab === 'realtime' }">
                <div class="row">
                    <div class="col-md-6">
                        <!-- <CameraView title="即時影像1" videoUrl="https://su.hackdog.tw/cam1" /> -->
                    </div>
                    <div class="col-md-6">
                        <!-- <CameraView title="即時影像2" videoUrl="https://su.hackdog.tw/cam2" /> -->
                    </div>
                </div>
            </div>

            <!-- 歷史影像 -->
            <div class="tab-pane fade" :class="{ show: activeTab === 'history', active: activeTab === 'history' }">
                <div class="row">
                    <div class="col-md-6">
                        <RecordView id="cam1" title="客廳" :folders="cam1historyList"/>
                    </div>
                    <div class="col-md-6">
                        <RecordView id="cam2" title="車庫" :folders="cam2historyList"/>
                    </div>
                </div>

            </div>
        </div>
    </div>
</template>
