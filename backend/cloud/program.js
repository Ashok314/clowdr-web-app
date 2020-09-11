/* global Parse */
// ^ for eslint

var jwt = require('jsonwebtoken');
const crypto = require('crypto');

const axios = require('axios');

const csvParse = require('csv-parse/lib/sync')

var moment = require('moment-timezone');
const Twilio = require("twilio");
const Papa = require('./papaparse.min');
const { response } = require('express');
let UserProfile = Parse.Object.extend("UserProfile");
let ProgramPerson = Parse.Object.extend("ProgramPerson");
let ZoomRoom = Parse.Object.extend("ZoomRoom");
var xml2json = require('xml2json');

const backOff = require('exponential-backoff').backOff;
async function callWithRetry(twilioFunctionToCall) {
    const response = await backOff(twilioFunctionToCall,
        {
            startingDelay: 500,
            retry: (err) => {
                if (err && err.code === 20429)
                    return true;
                console.error(err);
                return false;
            }
        });
    return response;
}


// Is the given user in any of the given roles?
async function userInRoles(user, allowedRoles) {
    const roles = await new Parse.Query(Parse.Role).equalTo('users', user).find();
    return roles.find(r => allowedRoles.find(allowed => r.get("name") === allowed));
}

function pointify(data) {
    if (data.clazz && data.id) {
        // console.log('[pointify]: found pointer of type ' + data.clazz);
        let C = Parse.Object.extend(data.clazz);
        return C.createWithoutData(data.id)
    }
    for (const k of Object.keys(data)) {
        // console.log("[pointify]: looking at " + k + ": " + JSON.stringify(data[k]));
        if (!Array.isArray(data[k]) && typeof data[k] === 'object' && data[k] !== null) {
            // console.log("[pointify]: found object " + JSON.stringify(data[k]));
            if (data[k].clazz) {
                data[k] = pointify(data[k]);
            }
        } else if (Array.isArray(data[k])) {
            // console.log("[pointify]: found array " + JSON.stringify(data[k]));
            data[k] = data[k].map(element => pointify(element));
        }
    }
}

Parse.Cloud.define("create-obj", async (request) => {
    let data = request.params;
    let clazz = request.params.clazz;
    let confID = request.params.conference;
    delete data.clazz;
    console.log(`[create obj]: request to create ${clazz} in ${confID}`);

    if (await userInRoles(request.user, [confID.id + "-admin", confID.id + "-manager"])) {
        console.log('[create obj]: user has permission to create obj');

        let Clazz = Parse.Object.extend(clazz);
        let obj = new Clazz();
        pointify(data);
        let acl = new Parse.ACL();
        acl.setPublicReadAccess(true);
        acl.setPublicWriteAccess(false);
        acl.setRoleWriteAccess(confID.id + "-manager", true);
        acl.setRoleWriteAccess(confID.id + "-admin", true);
        obj.setACL(acl);

        let res = await obj.save(data, { useMasterKey: true });

        if (!res) {
            throw new Error("Unable to create obj");
        }

        console.log('[create obj]: successfully created ' + obj.id);
        return { status: "OK", "id": obj.id };
    }
    else
        throw new Error("Unable to create obj: user not allowed to create new objects");
});

Parse.Cloud.define("update-obj", async (request) => {
    let data = request.params;
    let clazz = request.params.clazz;
    let confID = request.params.conference;
    let id = request.params.id;

    delete data.clazz;
    delete data.conference;
    console.log(`[update obj]: request to update ${data.id} of class ${clazz} in ${confID}`);

    if (await userInRoles(request.user, [confID.id + "-admin", confID.id + "-manager"])) {
        console.log('[update obj]: user has permission to update obj');
        let Clazz = Parse.Object.extend(clazz);
        let obj = await new Parse.Query(Clazz).get(id);
        if (!obj) {
            throw new Error(`Unable to update obj: ${id} not found`);
        }

        pointify(data);
        let res = await obj.save(data, { useMasterKey: true });

        if (!res) {
            throw new Error("Unable to update obj");
        }

        console.log('[update obj]: successfully updated ' + obj.id);
        return { status: "OK", "id": obj.id };

    }
    else
        throw new Error("Unable to update obj: user not allowed to update objects");
});

Parse.Cloud.define("delete-obj", async (request) => {
    let confID = request.params.conference;
    let id = request.params.id;
    let clazz = request.params.clazz;
    console.log(`[delete obj]: request to delete ${id} of class ${clazz} in ${confID}`);

    if (await userInRoles(request.user, [confID.id + "-admin", confID.id + "-manager"])) {
        console.log('[delete obj]: user has permission to delete obj');
        let Clazz = Parse.Object.extend(clazz);
        let obj = await new Parse.Query(Clazz).get(id);
        if (obj) {
            await obj.destroy({ useMasterKey: true });
        }
        else {
            throw new Error(`Unable to delete obj: ${id} not found`);
        }

        console.log('[delete obj]: successfully deleted ' + id);
        return { status: "OK", "id": obj.id };
    }
    else
        throw new Error("Unable to delete obj: user not allowed to delete objects");
});


Parse.Cloud.define("rooms-upload", async (request) => {
    console.log('Request to upload rooms data');
    const data = request.params.content;
    const conferenceID = request.params.conference;

    var Conference = Parse.Object.extend("Conference");
    var q = new Parse.Query(Conference);
    let conference = await q.get(conferenceID);

    if (!conference) {
        response.error("Bad conference ID");
        return;
    }

    var Room = Parse.Object.extend("ProgramRoom");
    var rquery = new Parse.Query(Room);
    rquery.equalTo("conference", conference);
    rquery.limit(1000);
    let config = await getConfig(conference);

    rquery.find().then(async (existing) => {
        let toSave = [];
        let acl = new Parse.ACL();
        acl.setPublicWriteAccess(false);
        acl.setPublicReadAccess(true);
        acl.setRoleWriteAccess(conferenceID + "-manager", true);
        acl.setRoleWriteAccess(conferenceID + "-admin", true);

        let rows = Papa.parse(data, { header: true });
        // rows.data.forEach(element => {
        //     addRow(element, conference, existing, toSave, acl);
        // });
        for (let row of rows.data) {
            let name = row.Name.trim();
            if (!name)
                continue;
            let room = existing.find(r => r.get("name").trim() === name);
            if (!room) {
                throw new Error("Unable to find room: " + row.Name);
            }
            if (row.YouTube) {
                // let data = getIDAndPwd(row.YouTube);
                let data = row.YouTube;
                room.set("src1", "YouTube")
                room.set("id1", data);
                // BCP: Is this the right way to clear out the other fields?
                room.set("pwd1", "");
                room.set("pwd2", "");
                if (row.iQIYI) {
                    let data2 = getIDAndPwd(row.iQIYI)
                    room.set("src2", "iQIYI")
                    room.set("id2", data2[0]);
                } else { // BCP: Is this the right way to clear out the other fields?
                    room.set("src2", "")
                    room.set("id2", "");
                }
                room.set("qa", (row.QA ? row.QA : ""));
            }
            else if (row.Zoom) {
                room.set("src1", "ZoomUS")
                room.set("src2", "ZoomCN")
                let data = getIDAndPwd(row.Zoom);
                room.set("id1", data[0]);
                room.set('pwd1', data[1]);
                room.set("id2", data[0]);
                room.set('pwd2', data[1]);
            }
            toSave.push(room);
        }
        console.log(`--> Saving ${toSave.length} rooms`)

        Parse.Object.saveAll(toSave, { useMasterKey: true })
            .then(() => console.log("[Rooms]: Done saving all rooms "))
            .catch(err => console.log('[Rooms]: error: ' + err));
    }).catch(err => {
        console.log('[Rooms]: Problem fetching rooms ' + err);
        throw err
    });

});

function getIDAndPwd(str) {
    let url = new URL(str)
    let id = "";
    let pwd = "";
    if (url.pathname) {
        let parts = url.pathname.split('/');
        id = parts[parts.length - 1];
    }
    if (url.searchParams) {
        pwd = url.searchParams.get('pwd');
    }
    return [id, pwd];
}

// function addRow(row, conference, existing, toSave, acl) {
//     if (row.Name) {
//         let name = row.Name.trim();
//         if (!existing.find(r => r.get("name").trim() == name)) {
//             var Room = Parse.Object.extend("ProgramRoom");
//             var room = new Room();
//             room.set("conference", conference);
//             room.set("name", name);
//             room.setACL(acl);
//             if (row.YouTube) {
//                 let data = getIDAndPwd(row.YouTube);
//                 room.set("src1", "YouTube")
//                 room.set("id1", data[0]);
//                 if (row.iQIYI) {
//                     let data2 = getIDAndPwd(row.iQIYI)
//                     room.set("src2", "iQIYI")
//                     room.set("id2", data2[0]);
//
//                 }
//                 room.set("qa", (row.QA ? row.QA : ""));
//             }
//             else if (row.Zoom) {
//                 room.set("src1", "ZoomUS")
//                 room.set("src2", "ZoomCN")
//                 let data = getIDAndPwd(row.Zoom);
//                 room.set("id1", data[0]);
//                 room.set('pwd1', data[1]);
//                 room.set("id2", data[0]);
//                 room.set('pwd2', data[1]);
//             }
//             else
//                 return
//
//             toSave.push(room);
//         }
//         else
//             console.log('[Rooms]: Skipping existing room ' + row.Name);
//     }
// }

let allPeople = {};
let allItems = {};
let allSessions = {};

function getAuthors(authorKeys) {
    let authors = [];
    authorKeys.forEach(key => {
        let author = allPeople[key];
        if (author)
            authors.push(author);
        else
            console.log(`Warning: author ${key} not found`)
    })
    return authors;
}

function timeFromConfTime(date, time, timezone) {
    let startTime = date + ' ' + time;
    return moment.tz(startTime, "YYYY/MM/DD HH:mm", timezone)
        // .subtract(10,'days')
        .toDate();
}
function removeHTMLEntities(str) {
    return str.replace(/&amp;/g, "&").replace(/&amp;/g, "&");
}

Parse.Cloud.define("program-upload", async (request) => {
    let data = request.params.content;
    const conferenceID = request.params.conference;
    const timezone = request.params.timezone;
    const format = request.params.format;
    console.log('Request to upload program data ' + format);
    if (format === "conf-json") {
        return uploadProgramFromConfJSON(data, conferenceID, timezone);
    } else if (format === "conf-xml") {
        return uploadProgramFromConfXML(data, conferenceID, timezone);
    } else if(format == "csv"){
        return uploadProgramFromCSV(data, conferenceID, timezone);
    }
    else {
        throw new Error("Unknown upload format: " + format);
    }
});

async function uploadProgramFromCSV(data, conferenceID, timezone){
    const records = csvParse(data, {columns: true, trim: true, skip_empty_lines: true
    });
    let tracks = {};
    let sessions = {};
    let rooms = {};
    let items = {};
    let persons = {};
    let events = [];
    for (let record of records) {
        let tName = record['Track Name'];
        if (!tracks[tName]) {
            tracks[tName] = {name: tName, obj: undefined};
        }
        let track = tracks[tName];
        let rName = record["Room Name"];
        if (rName && !rooms[rName]) {
            rooms[rName] = {name: rName, obj: undefined};
        }
        let room = rName ? rooms[rName] : undefined;
        let sName = record["Session Name"];
        if (sName && !sessions[sName]) {
            sessions[sName] = {name: sName, room: room, obj: undefined,
                track: track
            };
        }
        let session = sName ? sessions[sName]: undefined;
        if(session && session.room != room){
            throw "Session " + sName + " found in multiple rooms: " + rName + " and " + session.room.name + ". Please make sure that each session is assigned to exactly one room";
        }
        let iName = record['Event Title'];
        if (!items[iName]) {
            let authors = record['Event Authors'].split(",").map(name => {
                name = name.trim();
                if (!persons[name]) {
                    persons[name] = {name: name, obj: undefined};
                }
                return persons[name];
            });
            items[iName] = {
                name: iName,
                abstract: record['Event Abstract'],
                authors: authors,
                track: track
            }
        }
        if (record['Event Start Time'] || record['Event End Time']) {
            if (!session)
                throw "All scheduled events must be in a session, but found one that wasn't. Either put it in a session or remove the start/end times. Item: " + iName;
            console.log("--> " + record['Event Start Time'] + " " + timezone);
            let sTime = moment.tz(record['Event Start Time'], timezone);
            if (!sTime) {
                throw "Invalid start time specified '" + sTime + "' in record" + JSON.stringify(record) + ". Please use the format YYYY-MM-DD HH:mm";
            }
            let eTime = moment.tz(record['Event End Time'], timezone);
            if (!eTime) {
                throw "Invalid end time specified '" + eTime + "' in record"  + JSON.stringify(record) + ". Please use the format YYYY-MM-DD HH:mm";
            }
            if (eTime < sTime)
                throw "Invalid start/end time specified: start must be before end (found " + sTime + ", " + eTime + ")";
            if (!session.eTime || !session.sTime) {
                session.eTime = eTime;
                session.sTime = sTime;
            }
            if (sTime < session.sTime)
                session.sTime = sTime;
            if (eTime > session.eTime)
                session.eTime = eTime;
            events.push({
                sTime: sTime,
                eTime: eTime,
                item: items[iName],
                session: session,
                track: track
            });
        }else{
            events.push({
                item: items[iName],
                track: track
            });
        }

    }
    let confQ = new Parse.Query("Conference")
    confQ.equalTo("objectId", conferenceID)
    let conf = await confQ.first();
    let itemsQ = new Parse.Query("ProgramItem");
    itemsQ.equalTo("conference", this.currentConference);
    itemsQ.limit(10000);
    let personsQ = new Parse.Query("ProgramPerson");
    personsQ.equalTo("conference", this.currentConference);
    personsQ.limit(10000);
    let trackQ = new Parse.Query("ProgramTrack");
    trackQ.equalTo("conference", this.currentConference);
    trackQ.limit(10000);
    let roomQ = new Parse.Query("ProgramRoom");
    roomQ.equalTo("conference", this.currentConference);
    roomQ.limit(10000);
    let sessionQ = new Parse.Query("ProgramSession");
    sessionQ.equalTo("conference", this.currentConference);
    sessionQ.limit(10000);
    let eventQ = new Parse.Query("ProgramSessionEvent");
    eventQ.equalTo("conference", this.currentConference);
    eventQ.limit(10000);

    let [existingItems, existingPersons, existingTracks, existingRooms, existingSessions, existingEvents] = await Promise.all([itemsQ.find({useMasterKey: true}),
        personsQ.find({useMasterKey: true}), trackQ.find({useMasterKey: true}), roomQ.find({useMasterKey: true}), sessionQ.find({useMasterKey: true}), eventQ.find({useMasterKey: true})]);
    let ProgramRoom = Parse.Object.extend('ProgramRoom');
    let ProgramTrack = Parse.Object.extend('ProgramTrack');
    let ProgramPerson = Parse.Object.extend("ProgramPerson");
    let ProgramItem = Parse.Object.extend("ProgramItem");
    let ProgramSession = Parse.Object.extend("ProgramSession");
    let ProgramSessionEvent = Parse.Object.extend("ProgramSessionEvent");

    let acl = new Parse.ACL();
    acl.setPublicWriteAccess(false);
    acl.setPublicReadAccess(true);
    acl.setRoleWriteAccess(conf.id + "-manager", true);
    acl.setRoleWriteAccess(conf.id + "-admin", true);

    let toSave = [];
    for(let room of Object.values(rooms)){
        let existing = existingRooms.find(r=>r.get("name") == room.name);
        if(!existing)
        {
            existing =new ProgramRoom();
            existing.set("name", room.name);
            existing.set("isEventFocusedRoom", true)
            existing.set("conference", conf)
            existing.setACL(acl);
            toSave.push(existing);
        }
        room.obj = existing;
    }
    try {
        await Parse.Object.saveAll(toSave, {useMasterKey: true});
    } catch (err) {
        console.log("Unable to save rooms")
        console.log(err);
        throw err;
    }
    toSave = [];
    for(let track of Object.values(tracks)){
        let existing = existingTracks.find(r=>r.get("name") == track.name);
        if(!existing)
        {
            existing =new ProgramTrack();
            existing.set("name", track.name);
            existing.set("displayName", track.name);
            existing.set("conference", conf)
            existing.set("showAsEvents", true);
            existing.setACL(acl);
            toSave.push(existing);
        }
        track.obj = existing;
    }
    try {
        await Parse.Object.saveAll(toSave, {useMasterKey: true});
    } catch (err) {
        console.log("Unable to save tracks")
        console.log(err);
        throw err;
    }
    toSave = [];
    for(let person of Object.values(persons)){
        let existing = existingPersons.find(p=>p.get("name") == person.name);
        if(!existing){
            existing = new ProgramPerson();
            existing.set("name", person.name);
            existing.set("conference", conf);
            existing.setACL(acl);
            toSave.push(existing);
        }
        person.obj = existing;
    }
    try {
        await Parse.Object.saveAll(toSave, {useMasterKey: true});
    } catch (err) {
        console.log("Unable to save persons")
        console.log(err);
        throw err;
    }
    toSave = [];
    let authorsToSave = {};
    for(let item of Object.values(items)){
        let existing = existingItems.find(item=>item.get("title") == item.name);
        if(!existing){
            existing = new ProgramItem();
        }
        existing.set("title", item.name);
        existing.set("abstract", item.abstract);
        let authors = [];
        if(item.authors){
            authors = item.authors.map(p=>p.obj);
        }
        existing.set("events", []);
        existing.set("authors", authors);
        existing.set("conference", conf);
        existing.set("track", item.track.obj);
        existing.setACL(acl);
        for (let author of authors) {
            if (!author.get("programItems"))
                author.set("programItems", []);
            let items = author.get("programItems");
            items.push(existing);
            authorsToSave[author.get("name")] = author;
        }
        toSave.push(existing);
        item.obj = existing;
    }
    try {
        await Parse.Object.saveAll(toSave, {useMasterKey: true});
        await Parse.Object.saveAll(Object.values(authorsToSave), {useMasterKey: true});
    } catch (err) {
        console.log("Unable to save items + authors")
        console.log(err);
        throw err;
    }
    toSave = [];
    for(let session of Object.values(sessions)){
        let existing = existingSessions.find(s=>s.get("title") == session.name);
        if(!existing){
            existing = new ProgramSession();
        }
        if(!session.sTime || !session.eTime)
            throw "Error: did not find events with start or end times for session " + session.title
        existing.set("startTime", session.sTime.toDate());
        existing.set("endTime", session.eTime.toDate());
        existing.set("title",session.name);
        existing.set("programTrack", session.track.obj);
        existing.set("conference", conf);
        existing.set("room", session.room.obj);
        existing.setACL(acl);
        toSave.push(existing);
        session.obj = existing;
        session.obj.set("items",[]);
        session.obj.set("events",[]);
    }
    try {
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
    } catch (err) {
        console.error("Unable to save sessions");
        console.log(err);
        throw err;
    }
    toSave = [];
    let toSaveAfterEvents = [];
    for (let event of events) {
        let existing = existingEvents.find((ev) => ev.get("programItem") && ev.get("programItem").id == event.item.id
            && (
                (!event.sTime && !ev.get("startTime")) ||
                (event.sTime && ev.get("startTime") == event.sTime.toDate() && ev.get("endTime") == event.eTime.toDate())
        ));
        if(!existing){
            existing = new ProgramSessionEvent();
            existing.set("conference", conf);
            existing.setACL(acl);
            existing.set("programItem", event.item.obj);
            if(event.session)
                existing.set("programSession", event.session.obj);
            existing.set("programTrack", event.track.obj);
            if(event.sTime) {
                existing.set("startTime", event.sTime.toDate());
                existing.set("endTime", event.eTime.toDate());
            }
            toSave.push(existing);
        }
        if(event.session){
            event.session.obj.get("events").push(existing);
            if(!event.session.obj.get("items").find(i=>i.id == event.item.obj.id)){
                event.session.obj.get("items").push(event.item.obj);
            }
            if(!toSaveAfterEvents.find(s=>s.id == event.session.obj.id))
                toSaveAfterEvents.push(event.session.obj);
        }
        event.item.obj.get("events").push(existing);
        if(!toSaveAfterEvents.find(i=>i.id == event.item.obj.id))
            toSaveAfterEvents.push(event.item.obj);
    }
    try {
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
        await Parse.Object.saveAll(toSaveAfterEvents, { useMasterKey: true });
    } catch (err) {
        console.error("Unable to save events");
        console.log(err);
        throw err;
    }

    //Last up: patch program item keys, we should really stop using this.
    let itemQ = new Parse.Query("ProgramItem");
    itemQ.equalTo("conference", conf);
    itemQ.doesNotExist("confKey");
    itemQ.limit(100000);
    let itemsToFix = await itemQ.find({ useMasterKey: true });
    for (let item of itemsToFix) {
        item.set("confKey", item.get("track").id + "/" + item.id);
    }
    await Parse.Object.saveAll(itemsToFix, { useMasterKey: true });

}

async function uploadProgramFromConfXML(data, conferenceID, timezone) {
    data = JSON.parse(xml2json.toJson(data));

    let allPeople = {};
    let allItems = {};
    let allSessions = {};
    let toSave = [];

    let newTracks = {};
    let newRooms = {}
    let newItems = {};
    let newEvents = {};
    let newPersons = {};
    let newSessions = {};

    for (let session of data.event.subevent) {
        if (session.timeslot) {
            if (!session.timeslot.length)
                session.timeslot = [session.timeslot]
            let ses = {
                Title: session.title,
                Abstract: session.description,
                room: session.room,
                startTime: timeFromConfTime(session.date, session['start_time'], timezone),
                endTime: timeFromConfTime(session.date, session['end_time'], timezone),
                track: session.tracks.track,
                items: [],
                id: session.subevent_id
            }
            newSessions[session.subevent_id] = ses;
            for (let item of session.timeslot) {
                let authors = [];
                if (item.title.startsWith("Session: ")) {
                    ses.startTime = timeFromConfTime(item.date, item['start_time'], timezone);
                    ses.endTime = timeFromConfTime(item.date, item['end_time'], timezone);
                    continue;
                }
                if (item.persons && item.persons.person) {
                    if (!item.persons.person.length)
                        item.persons.person = [item.persons.person];
                    for (let person of item.persons.person) {
                        let concatName = person['first_name'] + " " + person["last_name"];
                        concatName = concatName.trim();
                        newPersons[concatName] = {
                            name: concatName,
                            affiliation: person.affiliation
                        }
                        authors.push(concatName);
                    }
                }
                let i = {
                    title: item.title,
                    authors: authors,
                    abstract: removeHTMLEntities(item.description),
                    track: (item.tracks.length ? item.tracks[0].track : item.tracks.track),
                    startTime: timeFromConfTime(item.date, item['start_time'], timezone),
                    endTime: timeFromConfTime(item.date, item['end_time'], timezone),
                    session: session.subevent_id

                };
                ses.items.push(item.title);
                if (newItems[item.title] &&
                    newItems[item.title].abstract &&
                    (newItems[item.title].abstract !== "undefined"
                        || (newItems[item.title].authors
                            && newItems[item.title].authors.length))) {
                    // Ed: Err, nothing?
                } else {
                    newItems[item.title] = i
                }
                if (!newEvents[item.title]) {
                    newEvents[item.title] = [];
                }
                newEvents[item.title].push(i);
                newRooms[item.room] = {};
                newTracks[i.track] = {}
            }
        }
    }


    let confQ = new Parse.Query("Conference")
    confQ.equalTo("objectId", conferenceID)
    let conf = await confQ.first();

    let acl = new Parse.ACL();
    acl.setPublicWriteAccess(false);
    acl.setPublicReadAccess(true);
    acl.setRoleWriteAccess(conf.id + "-manager", true);
    acl.setRoleWriteAccess(conf.id + "-admin", true);

    let ProgramTrack = Parse.Object.extend('ProgramTrack');
    var qt = new Parse.Query(ProgramTrack);
    qt.equalTo("conference", conf);
    qt.limit(1000);
    var existingTracks = await qt.find({ useMasterKey: true });
    for (let name of Object.keys(newTracks)) {
        let existing = existingTracks.find(r => r.get("name") === name);
        if (existing) {
            newTracks[name] = existing;
        }
        else {
            let nt = new ProgramTrack();
            nt.setACL(acl);
            nt.set("conference", conf);
            nt.set("name", name);
            toSave.push(nt);
            newTracks[name] = nt;
        }
    }
    try {
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    console.log('TRacks saved: ' + toSave.length);
    toSave = [];

    let ProgramRoom = Parse.Object.extend('ProgramRoom');
    var qr = new Parse.Query(ProgramRoom);
    qr.equalTo("conference", conf);
    qr.limit(1000);
    var existingRooms = await qr.find({ useMasterKey: true });
    for (let name of Object.keys(newRooms)) {
        let simplifiedName = name.replace("Online |", "").trim();
        if (existingRooms.find(r => r.get('name') === simplifiedName)) {
            newRooms[name] = existingRooms.find(r => r.get("name") === simplifiedName);
            console.log('Room already exists: ' + name);
            continue;
        }
        let newRoom = new ProgramRoom();
        newRoom.set('name', simplifiedName);
        newRoom.set('conference', conf);
        newRoom.set("isEventFocusedRoom", true)
        newRoom.setACL(acl);
        toSave.push(newRoom);
        existingRooms.push(newRoom);
        newRooms[name] = newRoom;
    }
    try {
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    console.log('Rooms saved: ' + toSave.length);
    toSave = [];

    // Create People next
    let ProgramPerson = Parse.Object.extend("ProgramPerson");
    let qp = new Parse.Query(ProgramPerson);
    qp.equalTo("conference", conf);
    qp.limit(10000);
    let people = await qp.find({ useMasterKey: true });
    people.forEach((person) => {
        allPeople[person.get("name")] = person;
    })

    for (const name of Object.keys(newPersons)) {
        let person = newPersons[name];
        if (allPeople[person.name.trim()]) {
            newPersons[person.name.trim()] = allPeople[person.name.trim()];
            continue
        }

        let newPerson = new ProgramPerson();
        person.name ? newPerson.set("name", person.name.trim()) : newPerson.set("name", person.name);
        person.affiliation ? newPerson.set("affiliation", person.affiliation.trim()) : newPerson.set("affiliation", person.affiliation);
        newPerson.set("conference", conf);
        newPerson.setACL(acl);
        toSave.push(newPerson);
        newPersons[name] = newPerson;
    }
    try {
        console.log("People saved: " + toSave.length);
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    toSave = [];

    // Create Items
    let ProgramItem = Parse.Object.extend("ProgramItem");
    let q = new Parse.Query(ProgramItem);
    q.equalTo("conference", conf);
    q.limit(1000);
    let items = await q.find({ useMasterKey: true });
    items.forEach((item) => {
        allItems[item.get("confKey")] = item;
    })

    let authorsToSave = {};
    toSave = [];
    for (const item of Object.values(newItems)) {
        if (allItems[item.title.trim()]) {
            continue
        }
        let trackName = item.track;
        let track = newTracks[trackName];
        if (!track)
            console.log('Warning: Adding item without track: ' + item.Key);

        let newItem = new ProgramItem();
        item.title ? newItem.set("title", item.title.trim()) : newItem.set("title", item.title);
        // item.Type ? newItem.set("type", item.Type.trim()) : newItem.set("type", '');
        if (item.abstract === "undefined")
            item.abstract = "";
        item.abstract ? newItem.set("abstract", item.abstract.trim()) : newItem.set("abstract", item.abstract);
        let authors = [];
        if (item.authors) {
            authors = item.authors.map(name => newPersons[name]);
        }
        newItem.set("authors", authors);
        newItem.set("conference", conf);
        newItem.set('track', track);
        newItem.setACL(acl);
        // get authors pointers
        for (let author of authors) {
            console.log(author)
            if (!author.get("programItems"))
                author.set("programItems", []);
            let items = author.get("programItems");
            items.push(newItem);
            authorsToSave[author.get("name")] = author;
        }
        toSave.push(newItem);
        newItems[newItem.get("title")] = newItem;
    }
    try {
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
        await Parse.Object.saveAll(Object.values(authorsToSave), { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    console.log("Items saved: " + toSave.length);

    // Create Sessions
    let ProgramSession = Parse.Object.extend("ProgramSession");
    let qs = new Parse.Query(ProgramSession);
    qs.limit(10000);
    let sessions = await qs.find({ useMasterKey: true });
    sessions.forEach((session) => {
        allSessions[session.get("confKey")] = session;
    })

    toSave = [];
    for (const id of Object.keys(newSessions)) {
        let ses = newSessions[id];
        let session = new ProgramSession();

        ses.Title ? session.set("title", ses.Title.trim().replace("Session: ", "")) : session.set("title", ses.Title);
        ses.Abstract ? session.set("abstract", ses.Abstract.trim()) : session.set("abstract", ses.Abstract);
        // ses.Type ? session.set("type", ses.Type.trim()) : session.set("type", '');
        session.set("startTime", ses.startTime);
        session.set("endTime", ses.endTime);
        let trackName = ses.track;
        let track = newTracks[trackName];

        session.set("programTrack", track)
        session.set("conference", conf);
        session.set("room", newRooms[ses.room])
        session.setACL(acl);

        // Find the pointer to the room
        // Find the pointers to the items
        let items = [];
        if (ses.items) {
            ses.items.forEach((k) => {
                if (newItems[k])
                    items.push(newItems[k]);
                else
                    console.log("Could not find item: " + k);
            });
        }
        session.set("items", items);
        newSessions[id] = session;
        toSave.push(session);
    }
    try {
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    let ProgramSessionEvent = Parse.Object.extend("ProgramSessionEvent");

    let updateItems = [];
    toSave = [];
    //last, make all of the event entries
    for (let itemTitle of Object.keys(newEvents)) {
        let events = newEvents[itemTitle];
        let item = newItems[itemTitle];
        for (let event of events) {
            let e = new ProgramSessionEvent();
            let trackName = event.track;
            let track = newTracks[trackName];
            if (!track)
                console.log('Warning: Adding item without track: ' + item.Key);

            e.set("conference", conf);
            e.setACL(acl);
            e.set("programItem", item);
            e.set("programSession", newSessions[event.session])
            e.set("programTrack", track);
            e.set("startTime", event.startTime);
            e.set("endTime", event.endTime);
            toSave.push(e);
            if (!item.get("events")) {
                item.set("events", []);
            }
            item.get("events").push(e);
        }
        updateItems.push(item);
    }
    console.log('Adding sessions items: ' + toSave.length);

    await Parse.Object.saveAll(toSave, { useMasterKey: true });
    await Parse.Object.saveAll(updateItems, { useMasterKey: true });
    let itemQ = new Parse.Query("ProgramItem");
    itemQ.equalTo("conference", conf);
    itemQ.doesNotExist("confKey");
    itemQ.limit(100000);
    let itemsToFix = await itemQ.find({ useMasterKey: true });
    for (let item of itemsToFix) {
        item.set("confKey", item.get("track").id + "/" + item.id);
    }
    await Parse.Object.saveAll(itemsToFix, { useMasterKey: true });
    let sessionQ = new Parse.Query("ProgramSession");
    sessionQ.equalTo("conference", conf)
    sessionQ.limit(1000);
    let storedSessions = await sessionQ.find({ useMasterKey: true });
    for (let session of storedSessions) {
        let eventsQ = new Parse.Query("ProgramSessionEvent");
        eventsQ.equalTo("programSession", session)
        eventsQ.limit(1000);
        let events = await eventsQ.find({ useMasterKey: true });
        session.set("events", events);
    }
    await Parse.Object.saveAll(storedSessions, { useMasterKey: true });
    return { status: "ok" }
}

async function uploadProgramFromConfJSON(data, conferenceID, timezone) {
    data = JSON.parse(data);

    let conferoPeople = {};
    data.People.forEach((p) => {
        conferoPeople[p.Key.trim()] = p;
    })

    let tracks = {};
    data.Items.forEach(item => {
        let parts = item.Key.split("/");
        let trackName = parts[0].trim();
        if (trackName.includes('catering') || trackName === 'icse-2020-test')
            return;
        if (trackName in tracks)
            tracks[trackName] = tracks[trackName] + 1;
        else
            tracks[trackName] = 1;
    });

    let rooms = {}
    data.Sessions.forEach(session => {
        const loc = session.Location.trim();
        if (loc in rooms)
            rooms[loc] = rooms[loc] + 1;
        else
            rooms[loc] = 1;
    });

    let confQ = new Parse.Query("Conference")
    confQ.equalTo("objectId", conferenceID)
    let conf = await confQ.first();

    let acl = new Parse.ACL();
    acl.setPublicWriteAccess(false);
    acl.setPublicReadAccess(true);
    acl.setRoleWriteAccess(conf.id + "-manager", true);
    acl.setRoleWriteAccess(conf.id + "-admin", true);

    // Create the tracks first
    let newTracks = [];
    let ProgramTrack = Parse.Object.extend('ProgramTrack');
    var qt = new Parse.Query(ProgramTrack);
    qt.equalTo("conference", conf);
    qt.limit(100);
    var existingTracks = await qt.find({ useMasterKey: true });
    for (let [name] of Object.entries(tracks)) {
        if (existingTracks.find(t => t.get('name') === name)) {
            console.log('Track already exists: ' + name);
            continue;
        }
        let newTrack = new ProgramTrack();
        newTrack.set('name', name.trim());
        newTrack.set('conference', conf);
        newTrack.setACL(acl);
        newTracks.push(newTrack);
        existingTracks.push(newTrack);
    }
    try {
        await Parse.Object.saveAll(newTracks, { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    console.log('Tracks saved: ' + newTracks.length);

    // Create the rooms next
    let newRooms = [];
    let ProgramRoom = Parse.Object.extend('ProgramRoom');
    var qr = new Parse.Query(ProgramRoom);
    qr.equalTo("conference", conf);
    qr.limit(100);
    var existingRooms = await qr.find({ useMasterKey: true });
    for (let [name] of Object.entries(rooms)) {
        if (existingRooms.find(r => r.get('name') === name)) {
            console.log('Room already exists: ' + name);
            continue;
        }
        let newRoom = new ProgramRoom();
        newRoom.set('name', name.trim());
        newRoom.set('location', 'TBD');
        newRoom.set('conference', conf);
        newRoom.setACL(acl);
        newRooms.push(newRoom);
        existingRooms.push(newRoom);
    }
    try {
        await Parse.Object.saveAll(newRooms, { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    console.log('Rooms saved: ' + newRooms.length);

    // Create People next
    let ProgramPerson = Parse.Object.extend("ProgramPerson");
    let qp = new Parse.Query(ProgramPerson);
    qp.equalTo("conference", conf);
    qp.limit(10000);
    let people = await qp.find({ useMasterKey: true });
    people.forEach((person) => {
        allPeople[person.get("confKey")] = person;
    })
    let newPeople = [];
    for (const person of data.People) {
        if (allPeople[person.Key.trim()]) {
            continue
        }

        let newPerson = new ProgramPerson();
        person.Name ? newPerson.set("name", person.Name.trim()) : newPerson.set("name", person.Name);
        person.Bio ? newPerson.set("bio", person.Bio.trim()) : newPerson.set("bio", person.Bio);
        person.Affiliation ? newPerson.set("affiliation", person.Affiliation.trim()) : newPerson.set("affiliation", person.Affiliation);
        person.Key ? newPerson.set("confKey", person.Key.trim()) : newPerson.set("confKey", person.Key);
        person.URL ? newPerson.set("URL", person.URL.trim()) : newPerson.set("URL", person.URL);
        person.URLPhoto ? newPerson.set("URLPhoto", person.URLPhoto.trim()) : newPerson.set("URLPhoto", person.URLPhoto);
        newPerson.set("conference", conf);
        newPerson.setACL(acl);
        newPeople.push(newPerson);
        allPeople[newPerson.get("confKey")] = newPerson;
    }
    try {
        await Parse.Object.saveAll(newPeople, { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    console.log("People saved: " + newPeople.length);

    // Create Items
    let ProgramItem = Parse.Object.extend("ProgramItem");
    let q = new Parse.Query(ProgramItem);
    q.equalTo("conference", conf);
    q.limit(1000);
    let items = await q.find({ useMasterKey: true });
    items.forEach((item) => {
        allItems[item.get("confKey")] = item;
    })

    let newItems = [];
    let authorsToSave = {};
    for (const item of data.Items) {
        if (allItems[item.Key.trim()]) {
            continue
        }
        let parts = item.Key.split("/");
        let trackName = parts[0].trim();
        let track = existingTracks.find(t => t.get('name') === trackName);
        if (!track)
            console.log('Warning: Adding item without track: ' + item.Key);

        let newItem = new ProgramItem();
        item.Title ? newItem.set("title", item.Title.trim()) : newItem.set("title", item.Title);
        // item.Type ? newItem.set("type", item.Type.trim()) : newItem.set("type", '');
        newItem.set("type", item.Type)
        item.URL ? newItem.set("url", item.URL.trim()) : newItem.set("url", item.URL);
        item.Abstract ? newItem.set("abstract", item.Abstract.trim()) : newItem.set("abstract", item.Abstract);
        newItem.set("affiliations", item.Affiliations);
        newItem.set("conference", conf);
        item.Key ? newItem.set("confKey", item.Key.trim()) : newItem.set("confKey", item.Key);
        newItem.set('track', track);
        newItem.setACL(acl);
        // get authors pointers
        let authors = getAuthors(item.Authors);
        newItem.set("authors", authors);
        for (let author of authors) {
            if (!author.get("programItems"))
                author.set("programItems", []);
            let items = author.get("programItems");
            items.push(newItem);
            authorsToSave[author.get("confKey")] = author;
        }
        newItems.push(newItem);
        allItems[newItem.get("confKey")] = newItem;
    }
    try {
        await Parse.Object.saveAll(newItems, { useMasterKey: true });
        await Parse.Object.saveAll(Object.values(authorsToSave), { useMasterKey: true });
    } catch (err) {
        console.error(err);
    }
    console.log("Items saved: " + newItems.length);

    // Create Sessions
    let ProgramSession = Parse.Object.extend("ProgramSession");
    let qs = new Parse.Query(ProgramSession);
    qs.limit(10000);
    let sessions = await qs.find({ useMasterKey: true });
    sessions.forEach((session) => {
        allSessions[session.get("confKey")] = session;
    })

    let newSessions = [];
    for (const ses of data.Sessions) {
        let session = undefined;
        if (allSessions[ses.Key])
            session = allSessions[ses.Key];

        var start = Date.now(), end = Date.now();
        let times = ses.Time.split('-');
        if (times.length >= 2) {
            let startTime = ses.Day + ' ' + times[0];
            let endTime = ses.Day + ' ' + times[1];
            start = moment.tz(startTime, "YYYY-MM-DD HH:mm", timezone);
            end = moment.tz(endTime, "YYYY-MM-DD HH:mm", timezone);
            //            console.log('Time> ' + start.toDate() + ' ' + end.toDate());
        }

        if (!session) {
            session = new ProgramSession();
            // TODO: Ed: How is this supposed to work:
            // We just created a brand new session, so how is confKey set?
            allSessions[session.get("confKey")] = session;

            ses.Title ? session.set("title", ses.Title.trim()) : session.set("title", ses.Title);
            ses.Abstract ? session.set("abstract", ses.Abstract.trim()) : session.set("abstract", ses.Abstract);
            // ses.Type ? session.set("type", ses.Type.trim()) : session.set("type", '');
            session.set("type", ses.Type)
            session.set("startTime", start.toDate());
            session.set("endTime", end.toDate());
            ses.Location ? session.set("location", ses.Location.trim()) : session.set("location", ses.Location);
            ses.Key ? session.set("confKey", ses.Key.trim()) : session.set("confKey", ses.Key);
            session.set("conference", conf);
            session.setACL(acl);

            // Find the pointer to the room
            let room = existingRooms.find(r => r.get('name') === ses.Location);
            if (room)
                session.set("room", room);
            else
                console.log(`Warning: room ${ses.Location} not found for session ${ses.Title}`);
        }

        // Find the pointers to the items
        let items = [];
        if (ses.Items) {
            ses.Items.forEach((k) => {
                if (allItems[k])
                    items.push(allItems[k]);
                else
                    console.log("Could not find item: " + k);
            });
        }
        session.set("items", items);
        newSessions.push(session);
    }
    try {
        await Parse.Object.saveAll(newSessions, { useMasterKey: true });
        let toSave = [];
        for (const ses of data.Sessions) {
            if (ses.Items) {
                ses.Items.forEach((k) => {
                    if (allItems[k]) {
                        // console.log(allItems[k].get("program"))
                        if (!allItems[k].get("programSession")) {
                            allItems[k].set("programSession", allSessions[ses.Key])
                            toSave.push(allItems[k]);
                        }
                    }
                    else
                        console.log("Could not find item: " + k);
                });
            }
        }
        console.log('Resaving items: ' + toSave.length);
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
        console.log("Finished save-all");
    } catch (err) {
        console.error(err);
    }
    return { status: 'ok' };
}

//=======
let ConferenceConfig = Parse.Object.extend("ConferenceConfiguration");

let BreakoutRoom = Parse.Object.extend("BreakoutRoom");
async function getConfig(conference) {
    let configQ = new Parse.Query(ConferenceConfig);
    configQ.equalTo("conference", conference);
    let res = await configQ.find({ useMasterKey: true });
    let config = {};
    for (let obj of res) {
        config[obj.get("key")] = obj.get("value");
    }
    config.twilio = Twilio(config.TWILIO_ACCOUNT_SID, config.TWILIO_AUTH_TOKEN);
    config.twilioChat = config.twilio.chat.services(config.TWILIO_CHAT_SERVICE_SID);

    return config;
}

async function createBreakoutRoomForProgramItem(programItem) {

    let mode = "group";
    let maxParticipants = 50;

    let parseRoom = new BreakoutRoom();
    parseRoom.set("title", programItem.get("title"));
    parseRoom.set("conference", programItem.get("conference"));
    parseRoom.set("isPrivate", false);
    parseRoom.set("persistence", "persistent");
    parseRoom.set("mode", mode);
    parseRoom.set("capacity", maxParticipants);
    parseRoom.set("programItem", programItem);
    let acl = new Parse.ACL();
    acl.setPublicReadAccess(false);
    acl.setPublicWriteAccess(false);
    acl.setRoleReadAccess(programItem.get("conference").id + "-conference", true);
    parseRoom.setACL(acl);

    parseRoom = await parseRoom.save({}, { useMasterKey: true });
    programItem.set("breakoutRoom", parseRoom);
    await programItem.save({}, { useMasterKey: true })
}
Parse.Cloud.afterSave("ProgramSession", async (request) => {
    //Make sure that all of our items are pointing back to us
    let programSession = request.object;
    if (programSession.get("items") && programSession.get("items").length > 0) {
        let items = await Parse.Object.fetchAll(programSession.get("items"), { useMasterKey: true });
        let toSave = [];
        for (let item of items) {
            if (!item.get("programSession") || item.get("programSession").id !== programSession.id) {
                item.set("programSession", programSession);
                toSave.push(item);
            }
        }
        if (toSave.length > 0)
            await Parse.Object.saveAll(toSave, { useMasterKey: true });
    }
})

async function removeChatChannelFromConference(chatSID, confObj){
    let config = await getConfig(confObj);
    return callWithRetry(()=>config.twilioChat.channels(chatSID).remove());
}

Parse.Cloud.beforeDelete("ProgramItem", async (request) => {
    if (request.object.get("breakoutRoom")) {
        request.object.get("breakoutRoom").destroy({ useMasterKey: true });
    }
    if(request.object.get("chatSID")){
        removeChatChannelFromConference(request.object.get("chatSID"), request.object.get("conference"));
    }
});
Parse.Cloud.beforeSave("ProgramItem", async (request) => {
    let programItem = request.object;
    if (programItem.isNew()) {
        //TODO - when creating lots of program items doing it this way kills mongo
        //so for now, don't do this mapping for new objects...
        return;
    }
    try {
        if (programItem.dirty("authors")) {
            //Recalculate the items for each author
            let itemQ = new Parse.Query("ProgramItem");
            itemQ.include(["authors", "authors.userProfile"]);
            let oldItem = null;
            if (!programItem.isNew())
                oldItem = await itemQ.get(programItem.id, { useMasterKey: true });
            let newAuthors = [];
            for (let author of programItem.get("authors")) {
                newAuthors.push(author);
            }
            let toSave = [];
            if (oldItem && oldItem.get("authors")) {
                for (let author of oldItem.get("authors")) {
                    if (!newAuthors.find(v => v.id === author.id)) {
                        //no longer an author
                        let oldItems = author.get("programItems");
                        if (oldItems) {
                            oldItems = oldItems.filter(item => item.id !== programItem.id);
                            author.set("programItems", oldItems);
                            toSave.push(author);
                        }
                        if (author.get("userProfile")) {
                            programItem.getACL().setWriteAccess(author.get("userProfile").get('user'), false);
                        }

                    }
                }
            }
            if (oldItem && oldItem.get("authors"))
                newAuthors = newAuthors.filter(v => (!oldItem.get('authors').find(y => y.id === v.id)));
            if (newAuthors.length > 0) {
                try {
                    newAuthors = await Parse.Object.fetchAllWithInclude(newAuthors, ["userProfile"], { useMasterKey: true });
                } catch (err) {
                    console.error(err);
                    return;
                }
                let config = null;
                for (let author of newAuthors) {
                    let oldItems = author.get("programItems");
                    if (!oldItems)
                        oldItems = [];
                    if (!oldItems.find(v => v.id === programItem.id)) {
                        oldItems.push(programItem);
                        author.set("programItems", oldItems);
                        toSave.push(author);
                        if (author.get("userProfile")) {
                            programItem.getACL().setWriteAccess(author.get("userProfile").get("user"), true);
                        }
                        if (programItem.get("chatSID") && author.get("userProfile")) {
                            //add the author to the chat channel
                            if (!config)
                                config = await getConfig(programItem.get("conference"));
                            const _config = config;
                            callWithRetry(() => _config.twilioChat.channels(programItem.get("chatSID")).members.create({
                                identity: author.get("userProfile").id
                            }).catch(err => {
                                console.log(err);
                            }));
                        }
                    }
                }
            }
            if (programItem.get("attachments")) {
                for (let attachment of programItem.get("attachments")) {
                    attachment.setACL(programItem.getACL());
                    toSave.add(attachment);
                }
            }
            if (toSave.length > 0)
                await Parse.Object.saveAll(toSave, { useMasterKey: true });
        }
    } catch (err) {
        console.error(err);
        throw err;
    }

});
Parse.Cloud.afterSave("ProgramItem", async (request) => {
    let programItem = request.object;
    //Check to make sure that we don't need to make a video room for this
    if (programItem.isNew() && !programItem.get("breakoutRoom")) {
        let track = programItem.get("track");
        track = await track.fetch({ useMasterKey: true });
        if (track && track.get("perProgramItemVideo")) {
            //Create a breakoutroom for this program item
            await createBreakoutRoomForProgramItem(programItem, track);
        }
    }
});
Parse.Cloud.beforeSave("StarredProgram", async (request) => {
    let savedProgram = request.object;
    if (savedProgram.isNew()) {
        let acl = new Parse.ACL();
        acl.setPublicReadAccess(false);
        acl.setPublicWriteAccess(false);
        acl.setWriteAccess(request.user, true);
        acl.setReadAccess(request.user, true);
        savedProgram.setACL(acl);
    }
});
Parse.Cloud.beforeSave("ProgramItemAttachment", async (request) => {
    let attachment = request.object;
    if (attachment.isNew()) {
        let programItem = attachment.get("programItem");
        await programItem.fetch();
        request.context = { isNew: true };
        if (!request.master && !programItem.getACL().getWriteAccess(request.user)) {
            try {
                await programItem.save({}, { sessionToken: request.user.getSessionToken() });
            } catch (err) {
                throw new Error("You do not have write permissions for this Program Item.");
            }
        }
        attachment.setACL(programItem.getACL());
    }
    if (attachment.dirty("file")) {
        let attachmentType = attachment.get("attachmentType");
        await attachmentType.fetch();
        if (attachmentType.get("isCoverImage")) {
            let programItem = attachment.get("programItem");
            programItem.set("posterImage", attachment.get("file"));
            await programItem.save({}, { sessionToken: request.user.getSessionToken() });

        }
    }
});

Parse.Cloud.beforeDelete("ProgramItemAttachment", async (request) => {
    let attachment = request.object;
    let programItem = attachment.get("programItem");
    await programItem.fetch();
    if (attachment.get("file")) {
        let file = attachment.get("file");
        let attachmentType = attachment.get("attachmentType");
        await attachmentType.fetch();
        if (attachmentType.get("isCoverImage")) {
            programItem.set("posterImage", null);
            await programItem.save({}, { sessionToken: request.user.getSessionToken() });
        }
        // const split_url = file.url().split('/');
        // const filename = split_url[split_url.length - 1];
        const filename = file.name();
        await Parse.Cloud.httpRequest({
            url: `${process.env.REACT_APP_PARSE_DATABASE_URL}/files/${filename}`,
            method: 'DELETE',
            headers: {
                'X-Parse-Master-Key': process.env.PARSE_MASTER_KEY,
                'X-Parse-Application-Id': process.env.REACT_APP_PARSE_APP_ID
            }
        });
    }
    if (programItem.get("attachments")) {
        let attachments = programItem.get("attachments");
        attachments = attachments.filter(v => v.id !== attachment.id);
        programItem.set("attachments", attachments);
        await programItem.save({}, { useMasterKey: true });
    }
});

Parse.Cloud.beforeSave("ProgramTrack", async (request) => {
    let track = request.object;
    if (track.dirty("perProgramItemVideo")) {
        if (track.get("perProgramItemVideo")) {
            let itemQ = new Parse.Query("ProgramSessionEvent");
            itemQ.equalTo("programTrack", track);
            itemQ.include("programItem.breakoutRoom");
            itemQ.limit(1000);
            let items = await itemQ.find({ useMasterKey: true });
            let promises = [];
            for (let item of items) {
                if (!item.get("programItem").get("breakoutRoom")) {
                    promises.push(createBreakoutRoomForProgramItem(item.get("programItem"), track).catch(err => console.error(err)));
                }
                // if(item.get("breakoutRoom") && (!item.get("breakoutRoom").get("socialSpace") || item.get("breakoutRoom").get("socialSpace").id !=
                // item.get("programSession").get("room").get("socialSpace").id)){
                //     let breakout = item.get("breakoutRoom");
                //     breakout.set("socialSpace", item.get("programSession").get("room").get("socialSpace"));
                //     await breakout.save({},{useMasterKey: true});
                // }
            }
            await Promise.all(promises);
        } else {
            //     TODO Make sure no tracks have breakout rooms still...
        }
    }
    if (track.dirty("perProgramItemChat")) {
        if (track.get("perProgramItemChat")) {
            let itemQ = new Parse.Query("ProgramSessionEvent");
            itemQ.include("programItem");
            itemQ.equalTo("programTrack", track);
            itemQ.limit(1000);
            let config = await getConfig(track.get("conference"));
            let items = await itemQ.find({useMasterKey: true});
            for (let item of items) {
                if (!item.get("programItem").get("chatSID")) {
                    await getOrCreateChatForProgramItem(item.get('programItem'), config);
                }
            }


        }
    }

});

async function getOrCreateChatForProgramItem(item, config) {
    let attributes = {
        category: "programItem",
        programItemID: item.id
    }
    try {
        let chatRoom = await callWithRetry(() => config.twilioChat.channels.create(
            {
                friendlyName: item.get('title'),
                uniqueName: 'programItem-' + item.id,
                type: 'public',
                attributes: JSON.stringify(attributes)
            }));
        item.set("chatSID", chatRoom.sid);
        await item.save({}, { useMasterKey: true });
    }
    catch (err) {
        //Raced with another client creating the chat room
        let chatRoom = await callWithRetry(() => config.twilioChat.channels('programItem-' + item.id).fetch());
        // item.set("chatSID", chatRoom.sid);
        // await item.save({}, {useMasterKey: true});

        return chatRoom.sid;
    }
}


// Parse.Cloud.afterSave("ProgramPerson", async (request) => {
//     let person = request.object;
//     if (person.get("userProfile") &&
//         !eqInclNull(request.context.oldUserID, person.get("userProfile"))) {
//         let profile = person.get("userProfile");
//         let personsQ = new Parse.Query("ProgramPerson");
//         personsQ.equalTo("userProfile", profile);
//         let persons = await personsQ.find({useMasterKey: true});
//         profile.set("programPersons", persons);
//         if(person.get("programItems")){
//             Parse.Object.fetchAll(person.get("programItems")).then(( async (items) =>{
//                 let config = null;
//                 for(let item of items){
//                     if(item.get("chatSID")){
//                         //add the author to the chat channel
//                         if (!config)
//                             config = await getConfig(item.get("conference"));
//                         let member = config.twilioChat.channels(item.get("chatSID")).members.create({
//                             identity: profile.id
//                         }).catch(err=>{
//                             console.error(err);
//                         });
//                     }
//                 }
//             }));
//         }
//         try {
//             await profile.save({}, {useMasterKey: true});
//         } catch (err) {
//             console.log("On " + person.id)
//             console.error(err);
//         }
//     }
// });
// Parse.Cloud.beforeSave("ProgramPerson", async (request) => {
//     let person = request.object;
//     if (person.dirty("userProfile")) {
//         //items -> authors (array) -> userProfile
//         let personQ = new Parse.Query("ProgramPerson");
//         personQ.include("userProfile");
//         let oldPerson = await personQ.get(person.id,{useMasterKey: true});
//         let oldID = null;
//         if(oldPerson && oldPerson.get("userProfile"))
//             oldID = oldPerson.get("userProfile").id;
//         request.context ={oldUserID: oldID};
//         if(oldPerson && oldPerson.get("userProfile")) {
//             let profile = oldPerson.get("userProfile");
//             let oldPersonMappings = oldPerson.get("programPersons");
//             if(oldPersonMappings)
//             {
//                 profile.set("programPersons", oldPersonMappings.filter(v=>v.id != person.id));
//                 await profile.save({}, {useMasterKey: true});
//             }
//         }
//     }
// });
Parse.Cloud.define("program-updatePersons", async (request) => {
    let profileID = request.params.userProfileID;
    let personsIDs = request.params.programPersonIDs;
    let user = request.user;
    let existingPersonsQ = new Parse.Query("ProgramPerson");
    let fp = new UserProfile();
    fp.id = profileID;
    existingPersonsQ.equalTo("userProfile", fp);

    try {
        let requestedPersonIDs = [];
        let newPersonsToFetch = [];
        for (let pid of personsIDs) {
            let p = new ProgramPerson();
            p.id = pid;
            newPersonsToFetch.push(p);
            requestedPersonIDs.push(p);
        }

        let profileQ = new Parse.Query("UserProfile");

        let [profile, alreadyClaimedPersons
            , newPersonsToClaim
        ] = await
                Promise.all([profileQ.get(profileID, { useMasterKey: true }),
                existingPersonsQ.find({ useMasterKey: true }),
                Parse.Object.fetchAll(newPersonsToFetch, { useMasterKey: true })
                ]);

        if (profile.get("user").id !== user.id)
            throw new Error("Invalid profile ID");
        console.log(newPersonsToClaim)
        console.log(alreadyClaimedPersons)
        //Check to see what the changes if any are
        let toSave = [];
        for (let p of newPersonsToClaim) {
            if (!alreadyClaimedPersons.find(v => v.id === p.id)) {
                p.set("userProfile", profile);
                toSave.push(p);
                if (p.get("programItems")) {
                    Parse.Object.fetchAll(p.get("programItems")).then((async (items) => {
                        let config = null;
                        for (let item of items) {
                            item.getACL().setWriteAccess(user.id, true);
                            if (item.get("attachments")) {
                                for (let attachment of item.get("attachments")) {
                                    attachment.setACL(item.getACL());
                                }
                                Parse.Object.saveAll(item.get("attachments"));
                            }
                            if (item.get("chatSID")) {
                                //add the author to the chat channel
                                if (!config)
                                    config = await getConfig(item.get("conference"));
                                const _config = config;
                                callWithRetry(() => _config.twilioChat.channels(item.get("chatSID")).members.create({
                                    identity: profile.id
                                })).catch(err => {
                                    console.log(err);
                                });
                            }
                        }
                        Parse.Object.saveAll(items, { useMasterKey: true });
                    }));
                }
            }
        }
        for (let p of alreadyClaimedPersons) {
            if (!requestedPersonIDs.find(v => v.id === p.id)) {
                p.set("userProfile", null);
                if (p.get("programItems")) {
                    Parse.Object.fetchAll(p.get("programItems")).then((async (items) => {
                        for (let item of items) {
                            item.getACL().setWriteAccess(user.id, false);
                            for (let attachment of item.get("attachments")) {
                                attachment.setACL(item.getACL());
                            }
                            Parse.Object.saveAll(item.get("attachments"));
                        }
                        Parse.Object.saveAll(items, { useMasterKey: true });

                    }));
                }
                toSave.push(p);
            }
        }
        console.log(toSave)
        profile.set("programPersons", newPersonsToClaim);
        toSave.push(profile);
        await Parse.Object.saveAll(toSave, { useMasterKey: true });
    } catch (err) {
        console.error(err);
        throw err;
    }
});
function generateRandomString(length) {
    return new Promise((resolve, reject) => {
        crypto.randomBytes(length,
            function (err, buffer) {
                if (err) {
                    return reject(err);
                }
                var token = buffer.toString('hex');
                return resolve(token);
            });
    })
}
Parse.Cloud.beforeDelete("SocialSpace", async (request) => {
});
Parse.Cloud.beforeDelete("ProgramRoom", async (request) => {
    let room = request.object;
    if (room.get("zoomRoom")) {
        await room.get("zoomRoom").destroy({ useMasterKey: true });
    }
    if(room.get("socialSpace")){
        let ss = room.get("socialSpace");
        await ss.fetch({useMasterKey: true});
        if(ss.get("chatChannel")){
            removeChatChannelFromConference(ss.get("chatChannel"), room.get("conference"));
        }
        await room.get("socialSpace").destroy({useMasterKey: true});
    }
});
// Parse.Cloud.beforeDelete("ZoomRoom", async (request) => {
//     let room = request.object;
//     if(room.get("meetingID")){
//         let config = await getConfig(room.get("conference"));
//         const payload = {
//             iss: config.ZOOM_API_KEY,
//             exp: ((new Date()).getTime() + 5000)
//         };
//         const token = jwt.sign(payload, config.ZOOM_API_SECRET);
//         try {
//             //If we are changing the account, delete the meeting from zoom.
//             let res = await axios({
//                 method: 'delete',
//                 url: 'https://api.zoom.us/v2/meetings/' + room.get("meetingID"),
//                 headers: {
//                     'Authorization': 'Bearer ' + token,
//                     'User-Agent': 'Zoom-api-Jwt-Request',
//                     'content-type': 'application/json'
//                 }
//             });
//         }catch(err){
//             console.error(err);
//         }
//
//     }
// });
Parse.Cloud.beforeSave("ZoomRoom", async (request) => {
    let room = request.object;
    if (room.isNew()) {
        let confID = room.get("conference");
        if (!confID || !(request.master || await userInRoles(request.user, [confID.id + "-admin", confID.id + "-manager"]))) {
            throw new Error("You do not have permission to create a ZoomRoom for this conference");
        }
        let acl = new Parse.ACL();
        acl.setPublicReadAccess(false);
        acl.setPublicWriteAccess(false);
        acl.setRoleWriteAccess(confID.id + "-manager", true);
        acl.setRoleWriteAccess(confID.id + "-admin", true);

        acl.setRoleReadAccess(confID.id + "-moderator", true);
        acl.setRoleReadAccess(confID.id + "-manager", true);
        acl.setRoleReadAccess(confID.id + "-admin", true);

        room.setACL(acl);
    }

    if (room.dirty("hostAccount") || room.dirty("startTime") || room.dirty("endTime") || room.dirty("requireRegistration")) {
        if (room.get("startTime") && room.get("endTime")) {
            console.log("\n\n\nRegenerate meeting\n\n")
            let config = await getConfig(room.get("conference"));
            const payload = {
                iss: config.ZOOM_API_KEY,
                exp: ((new Date()).getTime() + 5000)
            };
            const token = jwt.sign(payload, config.ZOOM_API_SECRET);




            if (room.get("meetingID") && room.dirty("hostAccount")) {
                //If we are changing the account, delete the meeting from zoom.
                await axios({
                    method: 'delete',
                    url: 'https://api.zoom.us/v2/meetings/' + room.get("meetingID"),
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'User-Agent': 'Zoom-api-Jwt-Request',
                        'content-type': 'application/json'
                    }
                });
                room.set("meetingID", undefined);
            }


            let host = room.get("hostAccount");
            if (!host.isDataAvailable())
                await host.fetch({ useMasterKey: true });
            let programRoom = room.get("programRoom");
            if (!programRoom.isDataAvailable())
                await programRoom.fetch({ useMasterKey: true });

            let diffInHours = moment(room.get("endTime")).diff(moment(room.get("startTime")), 'hours');
            let recurrence = undefined;
            let duration = undefined;
            if (diffInHours < 24) {
                duration = (diffInHours + 1) * 60;
            } else {
                //Start on the first day at the startTime for the rest of the day, recur every day
                duration = 24 * 60;
                recurrence = {
                    type: 1,
                    repeat_interval: 1,
                    end_date_time: moment(room.get("endTime").toUTCString()).format("YYYY-MM-DD[T]HH:mm:ss[Z]")
                }
            }
            let registration_type = undefined;
            let approval_type = 2;
            if (room.get("requireRegistration")) {
                approval_type = 0;
                if (recurrence)
                    registration_type = 3;
            }
            let data = {
                topic: 'CLOWDR Room: ' + programRoom.get("name"),
                type: (recurrence ? 8 : 2),
                start_time: moment(room.get("startTime").toUTCString()).format("YYYY-MM-DD[T]HH:mm:ss[Z]"),
                duration: duration,
                timezone: "UTC",
                recurrence: recurrence,
                settings: {
                    host_video: true,
                    participant_video: false,
                    join_before_host: true,
                    mute_upon_entry: true,
                    registration_type: registration_type,
                    approval_type: approval_type,
                    audio: 'both',
                    waiting_room: false,
                    registrants_email_notification: false,
                    registrants_confirmation_email: false,
                    meeting_authentication: false,

                }
            }
            if (room.get("meetingID")) {
                data.password = room.get("meetingPassword");
                await axios({
                    method: 'patch',
                    url: 'https://api.zoom.us/v2/meetings/' + room.get("meetingID"),
                    data: data,
                    headers: {
                        'Authorization': 'Bearer ' + token,
                        'User-Agent': 'Zoom-api-Jwt-Request',
                        'content-type': 'application/json'
                    }
                });
            } else {
                let pwd = await generateRandomString(3);
                data.password = pwd;
                try {
                    let res = await axios({
                        method: 'post',
                        url: 'https://api.zoom.us/v2/users/' + host.get("email") + '/meetings',
                        data: data,
                        headers: {
                            'Authorization': 'Bearer ' + token,
                            'User-Agent': 'Zoom-api-Jwt-Request',
                            'content-type': 'application/json'
                        }
                    });
                    room.set("meetingID", "" + res.data.id);
                    room.set("meetingPassword", pwd);
                    room.set("start_url", res.data.start_url);
                    room.set("start_url_expiration", moment().add(2, "hours").toDate());
                    room.set("join_url", res.data.join_url);
                    room.set("registration_url", res.data.registration_url);
                    programRoom.set("src1", "ZoomUS");
                    programRoom.set("id1", "" + res.data.id);
                    programRoom.set("pwd1", pwd);
                    await programRoom.save({}, { useMasterKey: true });
                } catch (err) {
                    console.error(err);
                    if (err.response.data.errors)
                        console.log(err.response.data.errors)
                    throw new Error("Error creating zoom room");
                }
            }
        }

    }
});

