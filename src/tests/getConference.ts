import { Conference } from "@clowdr-app/clowdr-db-schema";
import { testData } from "./setupTests";

export default async function getConference() {
    const conf = await Conference.get(testData.Conference[0].id);
    if (!conf) {
        throw new Error("Could not get conference!");
    }
    return conf as Conference;
};
