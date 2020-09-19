import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ISimpleEvent } from "strongly-typed-events";
import { ProgramItem, ProgramSession, ProgramSessionEvent, ProgramTrack } from "../../classes/DataLayer";
import { DataUpdatedEventDetails } from "../../classes/DataLayer/Cache/Cache";
import { makeCancelable } from "../../classes/Util";
import useConference from "../../hooks/useConference";
import useLogger from "../../hooks/useLogger";

interface Props {
    sessions: Array<ProgramSession>;
    events: Array<ProgramSessionEvent>;
    /**
     * Time boundaries to group items into, in minutes.
     * 
     * Groups are automatically created for items before and after the
     * boundaries specified, to include up to a distance of 10 years.
     */
    timeBoundaries: Array<number>;
}

function arrangeBoundaries(timeBoundaries: Array<number>)
    : [Array<{ start: number, end: number, isLast: boolean }>, number] {
    let now = Date.now();
    let boundaries = timeBoundaries
        .sort((x, y) => x < y ? -1 : x === y ? 0 : 1) // Order them
        .reduce((acc, x) =>
            acc.length === 0
                ? [x]
                : acc[acc.length - 1] !== x
                    ? [...acc, x]
                    : acc
            , [] as number[]) // Remove gaps of zero
        .map(x => x * 60 * 1000); // Convert to milliseconds
    let boundaryPairs: Array<{ start: number, end: number, isLast: boolean }> = [];
    const insaneLengthOfTime = 1000 * 60 * 60 * 24 * 365 * 10; // Ten years in ms
    if (boundaries.length > 0) {
        let boundaryStart = now - insaneLengthOfTime;
        let boundaryEnd = now + boundaries[0];
        boundaryPairs.push({
            start: boundaryStart,
            end: boundaryEnd,
            isLast: boundaries.length === 1
        });
    }
    for (let i = 0; i < boundaries.length; i++) {
        let boundaryStart = now + boundaries[i];
        let boundaryEnd;
        if (i + 1 < boundaries.length) {
            boundaryEnd = now + boundaries[i + 1];
        }
        else {
            boundaryEnd = now + insaneLengthOfTime;
        }

        boundaryPairs.push({
            start: boundaryStart,
            end: boundaryEnd,
            isLast: i === boundaries.length - 1
        });
    }
    return [boundaryPairs, now];
}

interface ItemRenderData {
    title: string;
    track: string;
    isWatched: boolean;
    additionalClasses: string;
    url: string;
    sortValue: number;

    item: {
        type: "event";
        data: ProgramSessionEvent;
    } | {
        type: "session";
        data: ProgramSession;
    };
}

interface GroupRenderData {
    timeText: string;
    items: Array<ItemRenderData>;
}

interface RenderData {
    groups: Array<GroupRenderData>;
}

export default function Program(props: Props) {
    const conf = useConference();
    const [renderData, setRenderData] = useState<RenderData>({ groups: [] });
    const logger = useLogger("Sidebar/Program");
    const [refreshRequired, setRefreshRequired] = useState(true);
    /* For debugging */
    logger.disable();

    // Compute render data
    useEffect(() => {
        async function buildRenderData(): Promise<RenderData> {
            if (refreshRequired) {
                setRefreshRequired(false);
            }

            let groupedItems: {
                [timeBoundary: number]: {
                    startTime: Date,
                    endTime: Date,
                    sessions: Array<ProgramSession>,
                    events: Array<ProgramSessionEvent>,
                    isLast: boolean
                }
            } = {};
            let [boundaries, now] = arrangeBoundaries(props.timeBoundaries);
            // Initialise empty groups
            for (let boundary of boundaries) {
                groupedItems[boundary.start] = {
                    startTime: new Date(boundary.start),
                    endTime: new Date(boundary.end),
                    sessions: [],
                    events: [],
                    isLast: boundary.isLast
                };
            }

            // Place sessions into groups
            for (let session of props.sessions) {
                for (let boundary of boundaries) {
                    if (boundary.end <= now) {
                        if (session.endTime.getTime() <= boundary.end) {
                            groupedItems[boundary.start].sessions.push(session);
                            break;
                        }
                    }
                    else {
                        if (session.startTime.getTime() <= boundary.end) {
                            groupedItems[boundary.start].sessions.push(session);
                            break;
                        }
                    }
                }
            }

            // Place events into groups
            for (let event of props.events) {
                for (let boundary of boundaries) {
                    if (boundary.end <= now) {
                        if (event.endTime.getTime() <= boundary.end) {
                            groupedItems[boundary.start].events.push(event);
                            break;
                        }
                    }
                    else {
                        if (event.startTime.getTime() <= boundary.end) {
                            groupedItems[boundary.start].events.push(event);
                            break;
                        }
                    }
                }
            }

            // Filter out empty groups
            for (let groupKey in groupedItems) {
                let group = groupedItems[groupKey];
                if (group.events.length === 0 && group.sessions.length === 0) {
                    delete groupedItems[groupKey];
                    logger.info(`Deleting empty group: ${groupKey}`);
                }
            }

            // Build render data
            let newRenderData: RenderData = {
                groups: []
            };
            for (let groupKey in groupedItems) {
                let group = groupedItems[groupKey];
                let timeText: string;
                if (group.endTime.getTime() <= now) {
                    timeText = "Past";
                }
                else if (group.startTime.getTime() <= now) {
                    timeText = "Happening now";
                }
                else {
                    let distance = group.startTime.getTime() - now;
                    let units = "minutes";
                    distance = Math.floor(distance / (1000 * 60)); // Convert to minutes
                    if (distance >= 60) {
                        distance = Math.floor(distance / 60);
                        units = "hour" + (distance > 1 ? "s" : "");
                    }
                    timeText = `${group.isLast ? "Beyond" : "In"} ${distance} ${units}`;
                }

                logger.info(timeText, group);
                let items: Array<ItemRenderData>;
                items = await Promise.all(group.sessions.map(async session => {
                    let result: ItemRenderData = {
                        title: session.title,
                        url: `/session/${session.id}`,
                        track: (await session.track).name,
                        isWatched: false,
                        item: { type: "session", data: session },
                        sortValue: session.startTime.getTime(),
                        additionalClasses: "session"
                    };
                    return result;
                }));
                items = items.concat(await Promise.all(group.events.map(async event => {
                    let result: ItemRenderData = {
                        title: (await event.item).title,
                        url: `/event/${event.id}`,
                        track: (await event.track).shortName,
                        isWatched: false,
                        item: { type: "event", data: event },
                        sortValue: event.startTime.getTime(),
                        additionalClasses: "event"
                    };
                    return result;
                })));

                let groupRenderData: GroupRenderData = {
                    timeText: timeText,
                    items: items.sort((x, y) => x.sortValue < y.sortValue ? -1 : x.sortValue > y.sortValue ? 1 : 0)
                };
                newRenderData.groups.push(groupRenderData);
            }

            logger.info("Props.events (inner)", props.events);
            logger.info("Render data (inner)", newRenderData);

            return newRenderData;
        }

        let cancel: () => void = () => { };
        async function doBuildRenderData() {
            try {
                let p = makeCancelable(buildRenderData());
                cancel = p.cancel;
                let d = await p.promise;
                setRenderData(d);
            }
            catch (e) { 
                if (!e.isCanceled) {
                    throw e;
                }
            }
            finally {
                cancel = () => { };
            }
        }

        doBuildRenderData();

        return cancel;
    }, [logger, props.events, props.sessions, props.timeBoundaries, refreshRequired]);


    const onTrackUpdated = useCallback(function _onTrackUpdated() {
        setRefreshRequired(true);
    }, []);

    const onItemUpdated = useCallback(function _onItemUpdated() {
        setRefreshRequired(true);
    }, []);

    // Subscribe to data events
    useEffect(() => {
        let cancel: () => void = () => { };
        let unsubscribe: () => void = () => { };
        async function subscribeToUpdates() {
            try {
                const promises: [
                    Promise<ISimpleEvent<DataUpdatedEventDetails<"ProgramItem">>>,
                    Promise<ISimpleEvent<DataUpdatedEventDetails<"ProgramTrack">>>
                ] = [
                        ProgramItem.onDataUpdated(conf.id),
                        ProgramTrack.onDataUpdated(conf.id)
                    ];
                const promise = makeCancelable(Promise.all(promises));
                cancel = promise.cancel;
                const [ev1, ev2] = await promise.promise;
                const unsubscribe1 = ev1.subscribe(onTrackUpdated);
                const unsubscribe2 = ev2.subscribe(onItemUpdated);
                unsubscribe = () => {
                    unsubscribe1();
                    unsubscribe2();
                };
            }
            catch (e) {
                if (!e.isCanceled) {
                    throw e;
                }
            }
            finally {
                cancel = () => { };
            }
        }

        subscribeToUpdates();

        return () => {
            unsubscribe();
            cancel();
        }
    }, [conf.id, onTrackUpdated, onItemUpdated]);


    logger.info("Props.events", props.events);
    logger.info("Render data", renderData);

    let groupElems: Array<JSX.Element> = [];

    for (let group of renderData.groups) {
        let itemElems: Array<JSX.Element> = [];
        for (let item of group.items) {
            // TODO: Insert the "watch star" button
            // TODO: Enable the watch/unwatch
            itemElems.push(
                <li key={item.item.data.id} className={item.additionalClasses + (item.isWatched ? " watched" : "")}>
                    <Link to={item.url}>
                        <h3>{item.title}</h3>
                    </Link>
                    <div className="track">{item.track}</div>
                </li>);
        }

        let groupElem = <div className="group">
            <div className="time">{group.timeText}</div>
            <ul className="items">
                {itemElems}
            </ul>
        </div>;

        groupElems.push(groupElem);
    }

    return <div className="program">
        {groupElems.reduce((acc, x) => <>{acc}{x}</>, <></>)}
    </div>;
}
