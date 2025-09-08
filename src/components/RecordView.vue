<script setup lang="ts">
import { ref } from "vue";

interface HistoryRecordFolder {
    id: string
    date: string
    file: string[]
}
interface Props {
    id: string
    title: string
    folders: HistoryRecordFolder[]
}
const props = defineProps<Props>();
// const AM = ref<string[]>(["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"])
// const PM = ref<string[]>(["12", "13", "14", "15", "16", "17", "18", "19", "20", "21", "22", "23"])
const str1 = ref("/api/records/");
</script>

<template>
    <div class="col-sm-12">
            <div class="card">
                <div class="card-body">
                    <!-- title -->
                    <div class="d-md-flex align-items-center">
                        <div>
                            <h4 class="card-title">{{props.title}}</h4>
                        </div>
                        <div class="ml-auto">
                            <div class="dl">
                                <!-- <select class="custom-select">
                                    <option value="0" selected="">Monthly</option>
                                    <option value="1">Daily</option>
                                    <option value="2">Weekly</option>
                                    <option value="3">Yearly</option>
                                </select> -->
                            </div>
                        </div>
                    </div>
                    <!-- title -->
                </div>
                <div class="table-responsive">
                    <table class="table v-middle">
                        <thead>
                            <tr class="bg-light">
                                <th class="border-top-0">日期</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="item in props.folders" :key="item.id">
                                <td>{{item.date}}</td>
                                <td v-for="ele in item.file" :key="ele">
                                    <a :href="'/api/'+ props.id + '/records/' + item.date + '/' + ele + '.mp4'">
                                        {{ele}}
                                    </a>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
</template>

<style scoped></style>
