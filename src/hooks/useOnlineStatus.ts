import { UserProfile } from "@clowdr-app/clowdr-db-schema";
import { useEffect, useState } from "react";
import useMaybeChat from "./useMaybeChat";
import useSafeAsync from "./useSafeAsync";

export default function useOnlineStatus(userProfiles: UserProfile[]): Map<string, boolean> {
    const [onlineStatus, setOnlineStatus] = useState<Map<string, boolean>>(new Map());
    const mChat = useMaybeChat();

    useSafeAsync(async () => {
        const newStatuses = new Map(onlineStatus);
        await Promise.all(userProfiles?.map(async profile => {
            try {
                const online = await mChat?.getIsUserOnline(profile.id);
                if (online !== undefined) {
                    newStatuses.set(profile.id, online);
                } else if (onlineStatus.has(profile.id)) {
                    newStatuses.delete(profile.id);
                }
            } catch (e) {
                // Suppress error from Twilio caused by race condition:
                // when a user signs up, we receive an updated list of
                // user profiles but the corresponding Twilio user has
                // not yet been created.
                if (!e.toString().toLowerCase().includes("not found")) {
                    throw e;
                }
            }
        }));
        return newStatuses;
    }, setOnlineStatus, [userProfiles, mChat], "useOnlineStatus:setOnlineStatus");

    useEffect(() => {
        if (mChat) {
            const functionToOff = mChat.serviceEventOn("userUpdated", {
                componentName: "useOnlineStatus",
                caller: "setOnlineStatus",
                function: async (update) => {
                    if (update.updateReasons.includes("online")) {
                        const isOnline = await update.user.isOnline ?? false;
                        setOnlineStatus(status => {
                            const newStatus = new Map(status);
                            if (update.user.isOnline !== undefined) {
                                newStatus.set(update.user.profileId, isOnline);
                            } else if (newStatus.has(update.user.profileId)) {
                                newStatus.delete(update.user.profileId);
                            }
                            return newStatus;
                        })
                    }
                }
            });
            return async () => {
                const functionToOffId = await functionToOff;
                if (functionToOffId) {
                    mChat.serviceEventOff("userUpdated", functionToOffId);
                }
            };
        }
        return () => { };
    }, [mChat]);

    return onlineStatus;
}
