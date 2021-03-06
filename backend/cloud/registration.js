/* global Parse */
// ^ for eslint

// TODO: Function to trigger sending out (unsent) registration emails
// TODO: Function to trigger sending out reminder/repeat registration emails

// TODO: Before delete: Prevent delete if still in use anywhere

const { validateRequest } = require("./utils");
const { isUserInRoles, getRoleByName } = require("./role");
const sgMail = require("@sendgrid/mail");
const Config = require("./config.js");
const { logError } = require("./errors");

// Duplicated becvause otherwise dependency loop...
/**
 * @param {Parse.User} user
 * @param {string} confId
 * @returns {Promise<Parse.Object | null>}
 */
async function getProfileOfUser(user, confId) {
    const q = new Parse.Query("UserProfile");
    q.equalTo("conference", new Parse.Object("Conference", { id: confId }));
    q.equalTo("user", user);
    try {
        return await q.first({ useMasterKey: true });
    }
    catch {
        return null;
    }
}

// **** Registration **** //

async function getRegistrationById(id) {
    let query = new Parse.Query("Registration");
    return query.get(id, { useMasterKey: true });
}

async function configureDefaultRegistrationACLs(object) {
    const confId = object.get("conference").id;
    const adminRole = await getRoleByName(confId, "admin");

    const acl = new Parse.ACL();
    acl.setPublicReadAccess(false);
    acl.setPublicWriteAccess(false);
    acl.setRoleReadAccess(adminRole, true);
    acl.setRoleWriteAccess(adminRole, true);
    object.setACL(acl);
}

/**
 * @typedef {Object} RegistrationSpec
 * @property {string | undefined} [affiliation]
 * @property {string | undefined} [country]
 * @property {string} email
 * @property {Date | undefined} invitationSentDate
 * @property {string} name
 * @property {string | undefined} [newRole]
 * @property {Pointer} conference
 */

const createRegistrationSchema = {
    affiliation: "string?",
    country: "string?",
    email: "string",
    invitationSentDate: "date?",
    name: "string",
    conference: "string",
    newRole: "string?"
};

/**
 * Creates a Registration.
 *
 * Note: You must perform authentication prior to calling this.
 *
 * @param {RegistrationSpec} data - The specification of the new Registration.
 * @returns {Promise<Parse.Object>} - The new Registration
 */
async function createRegistration(data) {
    data.email = data.email.toLowerCase();

    let existingQ = new Parse.Query("Registration");
    existingQ.equalTo("conference", data.conference);
    existingQ.equalTo("email", data.email);
    const existingRegs = await existingQ.find({ useMasterKey: true });
    if (existingRegs.length > 0) {
        return existingRegs[0];
    }

    let existingU = new Parse.Query("_User");
    existingU.equalTo("email", data.email);
    const existingUsers = await existingU.find({ useMasterKey: true });
    if (existingUsers.length > 0) {
        const existingProfile = await getProfileOfUser(existingUsers[0], data.conference.id);
        if (existingProfile) {
            return true;
        }
    }

    const newObject = new Parse.Object("Registration", data);
    await configureDefaultRegistrationACLs(newObject);
    await newObject.save(null, { useMasterKey: true });
    return newObject;
}

/**
 * @param {Parse.Cloud.FunctionRequest} req
 */
async function handleCreateRegistration(req) {
    const { params, user } = req;

    const requestValidation = validateRequest(createRegistrationSchema, params);
    if (requestValidation.ok) {
        const confId = params.conference;

        const authorized = !!user && await isUserInRoles(user.id, confId, ["admin"]);
        if (authorized) {
            const spec = params;
            spec.conference = new Parse.Object("Conference", { id: confId });
            if ("roleName" in spec) {
                if (!("newRole" in spec)) {
                    spec.newRole = spec.roleName;
                }
                delete spec.roleName;
            }

            if (!("newRole" in spec) || !spec.newRole) {
                spec.newRole = "attendee";
            }

            spec.newRole = spec.newRole.toLowerCase();
            const result = await createRegistration(spec);
            if (result === true) {
                return true;
            }
            else {
                return result.id;
            }
        }
        else {
            throw new Error("Permission denied");
        }
    }
    else {
        throw new Error(requestValidation.error);
    }
}
Parse.Cloud.define("registration-create", handleCreateRegistration);

/**
 * @typedef {Object} SendRegistrationEmailsRequest
 * @property {boolean} sendOnlyUnsent
 * @property {Pointer} conference
 */

const sendregistrationEmailsSchema = {
    sendOnlyUnsent: "boolean",
    conference: "string"
};

/**
 * @typedef {Object} SendRegistrationEmailsResponse
 * @property {boolean} success
 * @property {SendRegistrationEmailResult[]} results
 */

/**
 * @typedef {Object} SendRegistrationEmailResult
 * @property {boolean} success
 * @property {string} to
 * @property {string} [reason]
 */

/**
 * Sends registration emails for conference attendees.
 *
 * Note: you must perform authentication prior to calling this function.
 *
 * @param {SendRegistrationEmailsRequest} data - The specification of the new Registration.
 * @returns {Promise<SendRegistrationEmailsResponse>} - The new Registration
 */
async function sendRegistrationEmails(data) {
    const regQ = new Parse.Query("Registration");
    regQ.equalTo("conference", data.conference);

    if (data.sendOnlyUnsent) {
        regQ.doesNotExist("invitationSentDate");
    }

    regQ.limit(10000);

    let registrations = await regQ.find({ useMasterKey: true });

    console.log(registrations);

    let config = await Config.getConfig(data.conference.id);

    if (!config.SENDGRID_API_KEY) {
        throw new Error("No SendGrid API key available.")
    }

    sgMail.setApiKey(config.SENDGRID_API_KEY);

    let sendMessagePromises = [];

    data.conference = await data.conference.fetch({ useMasterKey: true });

    let conferenceName = data.conference.get("name");
    let conferenceShortName = data.conference.get("shortName");

    let messageText = config.REGISTRATION_EMAIL_MESSAGE_TEXT;
    let messageHTML = config.REGISTRATION_EMAIL_MESSAGE_HTML;

    messageText = messageText.replace(/\$\{conferenceName\}/gi, conferenceName);
    messageText = messageText.replace(/\$\{conferenceShortName\}/gi, conferenceShortName);

    messageHTML = messageHTML.replace(/\$\{conferenceName\}/gi, conferenceName);
    messageHTML = messageHTML.replace(/\$\{conferenceShortName\}/gi, conferenceShortName);

    for (let registration of registrations) {
        let email = registration.get("email").toLowerCase();
        let link = `${config.REACT_APP_FRONTEND_URL}/register/${data.conference.id}/${registration.id}/${email}`;

        let thisMessageText = messageText.replace(/\$\{link\}/gi, link);
        let thisMessageHTML = messageHTML.replace(/\$\{link\}/gi, link);

        let message = {
            to: email,
            from: config.SENDGRID_SENDER,
            subject: `Action required for ${conferenceName}: activate your Clowdr profile`,
            text: thisMessageText,
            html: thisMessageHTML
        };

        console.log(`Sending email to ${email}`);

        sendMessagePromises.push(sgMail
            .send(message)
            .then(async _ => {
                try {
                    await registration.save("invitationSentDate", new Date(), { useMasterKey: true });
                    return { to: message.to, success: true };
                } catch (reason) {
                    console.error(`Failed to record that a registration invitation was sent to ${email}.`, reason)
                    await logError(registration.get("conference").id, undefined, 0, "sendRegistrationEmails:then:catch", reason);
                    return { to: message.to, success: false, reason }
                }
            })
            .catch(async error => {
                await logError(undefined, undefined, 0, "sendRegistrationEmails:catch", error);
                return { to: message.to, success: false, reason: error };
            }));
    }

    let results = await Promise.all(sendMessagePromises);

    return {
        success: results.every(result => result.success),
        results
    };
}

/**
 * @param {Parse.Cloud.FunctionRequest} req
 */
async function handleSendRegistrationEmails(req) {
    const { params, user } = req;

    const requestValidation = validateRequest(sendregistrationEmailsSchema, params);
    if (requestValidation.ok) {
        const confId = params.conference;

        const authorized = !!user && await isUserInRoles(user.id, confId, ["admin"]);
        if (authorized) {
            const spec = params;
            spec.conference = new Parse.Object("Conference", { id: confId });
            const result = await sendRegistrationEmails(spec);
            return result;
        }
        else {
            throw new Error("Permission denied");
        }
    }
    else {
        throw new Error(requestValidation.error);
    }
}
Parse.Cloud.define("registration-send-emails", handleSendRegistrationEmails);

Parse.Cloud.define("registration-save-many", async (req) => {
    const { params, user } = req;

    const requestValidation = validateRequest({
        conference: "string"
    }, params);
    if (requestValidation.ok) {
        const confId = params.conference;

        const authorized = !!user && await isUserInRoles(user.id, confId, ["admin"]);
        if (authorized) {
            if (!("registrations" in params)) {
                throw new Error("Registrations not provided");
            }
            const registrations = params.registrations;
            if (!(registrations instanceof Array)) {
                throw new Error("Registrations must be an array.");
            }

            const validRoles = ["attendee", "manager", "admin"];
            registrations.forEach((registration, idx) => {
                if (!("email" in registration)) {
                    throw new Error(`Email missing @${idx}`);
                }
                if (!("name" in registration)) {
                    throw new Error(`Name missing @${idx}`);
                }
                if (!("country" in registration)) {
                    throw new Error(`Country missing @${idx}`);
                }
                if (!("affiliation" in registration)) {
                    throw new Error(`Affiliation missing @${idx}`);
                }
                if (!("newRole" in registration) && !("roleName" in registration)) {
                    throw new Error(`New role missing @${idx}`);
                }

                if ("roleName" in registration) {
                    registration.newRole = registration.roleName;
                    delete registration.roleName;
                }

                if (typeof registration.email !== "string") {
                    throw new Error(`Email is of invalid type @${idx}`);
                }
                if (typeof registration.name !== "string") {
                    throw new Error(`Name is of invalid type @${idx}`);
                }
                if (typeof registration.country !== "string") {
                    throw new Error(`Country is of invalid type @${idx}`);
                }
                if (typeof registration.affiliation !== "string") {
                    throw new Error(`Affiliation is of invalid type @${idx}`);
                }
                if (typeof registration.newRole !== "string") {
                    throw new Error(`New role is of invalid type @${idx}`);
                }

                if (!registration.email || registration.email.trim() === "") {
                    throw new Error(`Email blank @${idx}`);
                }
                if (!registration.name || registration.name.trim() === "") {
                    throw new Error(`Name blank @${idx}`);
                }
                if (!registration.country || registration.country.trim() === "") {
                    throw new Error(`Country blank @${idx}`);
                }
                if (!registration.affiliation || registration.affiliation.trim() === "") {
                    throw new Error(`Affiliation blank @${idx}`);
                }
                if (!registration.newRole || registration.newRole.trim() === "") {
                    throw new Error(`New role blank @${idx}`);
                }

                registration.email = registration.email.trim().toLowerCase();
                registration.name = registration.name.trim();
                registration.affiliation = registration.affiliation.trim();
                registration.country = registration.country.trim();
                registration.newRole = registration.newRole.trim().toLowerCase();

                if (!validRoles.includes(registration.newRole)) {
                    throw new Error(`New role invalid @${idx}`);
                }
            });

            const conference = new Parse.Object("Conference", { id: confId });
            const existingRegistrations
                = await new Parse.Query("Registration")
                    .equalTo("conference", conference)
                    .map(x => x, { useMasterKey: true });
            const emailsExisting = new Set(existingRegistrations.map(x => x.get("email")));

            const results = await Promise.all(registrations.map(async (registration, idx) => {
                const spec = registration;
                try {
                    if (!("newRole" in spec) || !spec.newRole) {
                        spec.newRole = "attendee";
                    }
                    spec.newRole = spec.newRole.toLowerCase();

                    if (emailsExisting.has(spec.email)) {
                        const existingReg = existingRegistrations.find(x => x.get("email") === spec.email);
                        await existingReg.save(spec, { useMasterKey: true });
                        return { index: idx, result: true, email: spec.email };
                    }
                    else {
                        spec.conference = conference;

                        const result = await createRegistration(spec);
                        if (result === true) {
                            return { index: idx, result: true, email: spec.email };
                        }
                        else {
                            return { index: idx, result: result.id, email: spec.email };
                        }
                    }
                }
                catch (e) {
                    await logError(conference.id, undefined, 0, "registration-save-many:create-registration", e);
                    return { index: idx, result: false, email: spec.email, reason: e.toString() };
                }
            }));

            const emailsSaved = new Set(results.map(x => x.email));
            const emailsDeleted = Array.from(emailsExisting.values()).filter(x => !emailsSaved.has(x));
            await Promise.all(emailsDeleted.map(async (deletedEmail) => {
                try {
                    const existingReg = existingRegistrations.find(x => x.get("email") === deletedEmail);
                    await existingReg.destroy({ useMasterKey: true });
                }
                catch (e) {
                    await logError(conference.id, undefined, 0, "registration-save-many:delete-registration", e);
                    console.error(`Failed to delete registration for: ${deletedEmail} in conference ${confId}`);
                }
            }));

            return results;
        }
        else {
            throw new Error("Permission denied");
        }
    }
    else {
        throw new Error(requestValidation.error);
    }
});

module.exports = {
    getRegistrationById
};
