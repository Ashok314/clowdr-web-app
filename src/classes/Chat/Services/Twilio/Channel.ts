import Parse from "parse";
import { TextChat } from "@clowdr-app/clowdr-db-schema";
import { Paginator } from "twilio-chat/lib/interfaces/paginator";
import IChannel from "../../IChannel";
import Member from "./Member";
import Message from "./Message";
import { Channel as TwilioChannel } from "twilio-chat/lib/channel";
import { ChannelDescriptor as TwilioChannelDescriptor } from "twilio-chat/lib/channeldescriptor";
import { Member as TwilioMember } from "twilio-chat/lib/member";
import { Message as TwilioMessage } from "twilio-chat/lib/message";
import TwilioChatService from "./ChatService";
import MappedPaginator from "../../MappedPaginator";
import { MemberDescriptor } from "../../Chat";
import assert from "assert";

type ChannelOrDescriptor = TwilioChannel | TwilioChannelDescriptor;

export type ChannelEventNames
    = "memberJoined"
    | "memberLeft"
    | "memberUpdated"
    | "messageAdded"
    | "messageRemoved"
    | "messageUpdated"
    ;

export type MemberJoinedEventArgs = Member;
export type MemberLeftEventArgs = Member;
export type MemberUpdatedEventArgs = {
    member: Member,
    updateReasons: Array<TwilioMember.UpdateReason>
};

export type MessageAddedEventArgs = Message;
export type MessageRemovedEventArgs = Message;
export type MessageUpdatedEventArgs = {
    message: Message,
    updateReasons: Array<TwilioMessage.UpdateReason>
};

export type ChannelEventArgs<K extends ChannelEventNames> =
    K extends "memberJoined" ? MemberJoinedEventArgs
    : K extends "memberLeft" ? MemberLeftEventArgs
    : K extends "memberUpdated" ? MemberUpdatedEventArgs
    : K extends "messageAdded" ? MessageAddedEventArgs
    : K extends "messageRemoved" ? MessageRemovedEventArgs
    : K extends "messageUpdated" ? MessageUpdatedEventArgs
    : never;

export default class Channel implements IChannel {
    constructor(
        private textChat: TextChat,
        // We can't rely on `instanceof` to distinguish these types (argh!)
        private channel: { c: TwilioChannel } | { d: TwilioChannelDescriptor },
        private service: TwilioChatService
    ) {
    }

    private getCommonField<K extends keyof ChannelOrDescriptor>(s: K): ChannelOrDescriptor[K] {
        return 'c' in this.channel ? this.channel.c[s] : this.channel.d[s];
    }

    public get id(): string {
        return this.textChat.id;
    }

    public get sid(): string {
        return "c" in this.channel ? this.channel.c.sid : this.channel.d.sid;
    }

    private async upgrade(): Promise<TwilioChannel> {
        if ('d' in this.channel) {
            this.channel = { c: await this.channel.d.getChannel() };
        }
        try {
            // TODO: Where to put this? Putting it here can trigger either a
            // "conflicting member modification" error or a "member already
            // exists" error
            if (this.channel.c.status !== "joined") {
                // console.log(`Joining chat: ${this.channel.c.sid}`);
                await this.channel.c.join();
                // console.log(`Joined chat: ${this.channel.c.sid}`);
            }
        }
        catch (e) {
            const msg = (e.toString() as string).toLowerCase();
            if (!msg.includes("conflicting member modification") &&
                !msg.includes("member already exists")) {
                throw e;
            }
        }
        return this.channel.c;
    }

    async membersCount(): Promise<number> {
        if ('c' in this.channel) {
            return this.channel.c.getMembersCount();
        }
        else {
            return this.channel.d.membersCount;
        }
    }
    async members(): Promise<Array<Member>> {
        const channel = await this.upgrade();
        const twilioMembers = await channel.getMembers();
        return twilioMembers.map(x => new Member(x));
    }
    async getLastReadIndex(): Promise<number | null> {
        return this.getCommonField('lastConsumedMessageIndex');
    }
    async setLastReadIndex(value: number | null): Promise<void> {
        const channel = await this.upgrade();

        if (!value) {
            await channel.setNoMessagesConsumed();
        }
        else {
            await channel.updateLastConsumedMessageIndex(value);
        }
    }
    async addMembers(userProfileIds: string[]): Promise<void> {
        return Parse.Cloud.run("textChat-invite", {
            conference: (await this.textChat.conference).id,
            chat: this.textChat.id,
            members: userProfileIds
        });
    }
    async join(): Promise<void> {
        const channel = await this.upgrade();
        await channel.join();
    }
    async removeMembers(userProfileIds: string[]): Promise<void> {
        throw new Error("Method not implemented");
        // const channel = await this.upgrade();
        // await channel.removeMember(member.sid);
    }
    async getMember(memberProfileId: string | null): Promise<Member | "system"> {
        const channel = await this.upgrade();
        if (memberProfileId) {
            return new Member(await channel.getMemberBySid(memberProfileId));
        }
        else {
            return "system";
        }
    }
    getName(): string {
        return this.getCommonField('friendlyName');
    }
    async setName(value: string): Promise<void> {
        const channel = await this.upgrade();
        await channel.updateFriendlyName(value);
    }
    async getIsDM(): Promise<false | { member1: MemberDescriptor; member2: MemberDescriptor }> {
        if (this.textChat.isDM) {
            assert(this.service.conference);
            const channel = await this.upgrade();
            const members = await channel.getMembers();
            const [member1, member2] = members.map(x => new Member(x));

            const [member1Online, member2Online] = await Promise.all([
                member1.getOnlineStatus(),
                member2.getOnlineStatus()
            ]);

            return {
                member1: {
                    profileId: member1.profileId,
                    isOnline: member1Online
                },
                member2: {
                    profileId: member2.profileId,
                    isOnline: member2Online
                }
            };
        }
        else {
            return false;
        }
    }
    async getIsPrivate(): Promise<boolean> {
        return !Object.keys(this.textChat.acl.permissionsById).some(x => x.startsWith("role:") && x.includes("attendee"));
    }
    getStatus(): 'joined' | undefined {
        const status = this.getCommonField('attributes');
        if (status === "invited") {
            return undefined;
        }
        else if (status === "joined") {
            return "joined";
        }
        else {
            return undefined;
        }
    }
    async getIsAutoWatchEnabled(): Promise<boolean> {
        return this.textChat.autoWatch;
    }
    async setIsAutoWatchEnabled(value: boolean): Promise<void> {
        this.textChat.autoWatch = value;
        return this.textChat.save();
    }
    async delete(): Promise<void> {
        const channel = await this.upgrade();
        await channel.delete();
    }
    async getMessages(pageSize?: number, anchor?: number, direction?: string): Promise<Paginator<Message>> {
        // TODO: Process and attach reactions
        const channel = await this.upgrade();
        const pages = await channel.getMessages(pageSize, anchor, direction);
        return new MappedPaginator(pages, msg => new Message(msg, this));
    }
    async sendMessage(message: string): Promise<number> {
        const channel = await this.upgrade();
        return channel.sendMessage(message);
    }
    async addReaction(messageSid: string, reaction: string): Promise<{ ok: true } | undefined> {
        return this.service.requestClowdrTwilioBackend("react", {
            channel: 'c' in this.channel ? this.channel.c.sid : this.channel.d.sid,
            message: messageSid,
            reaction
        });
    }
    async removeReaction(messageSid: string, reaction: string): Promise<{ ok: true } | undefined> {
        return this.service.requestClowdrTwilioBackend("tcaer", {
            channel: 'c' in this.channel ? this.channel.c.sid : this.channel.d.sid,
            message: messageSid,
            reaction
        });
    }
    async subscribe(): Promise<void> {
        const channel = await this.upgrade();
        await channel._subscribe();
    }
    async unsubscribe(): Promise<void> {
        const channel = await this.upgrade();
        await channel._unsubscribe();
    }

    async on<K extends ChannelEventNames>(event: K, listener: (arg: ChannelEventArgs<K>) => void): Promise<() => void> {
        const channel = await this.upgrade();
        const _this = this;

        function memberWrapper(arg: TwilioMember) {
            listener(new Member(arg) as ChannelEventArgs<K>);
        }

        function memberUpdatedWrapper(arg: {
            member: TwilioMember;
            updateReasons: Array<TwilioMember.UpdateReason>
        }): void {
            listener({
                member: new Member(arg.member),
                updateReasons: arg.updateReasons
            } as ChannelEventArgs<K>);
        }

        function messageWrapper(arg: TwilioMessage): void {
            listener(new Message(arg, _this) as ChannelEventArgs<K>);
        }

        function messageUpdatedWrapper(arg: {
            message: TwilioMessage;
            updateReasons: Array<TwilioMessage.UpdateReason>
        }): void {
            listener({
                message: new Message(arg.message, _this),
                updateReasons: arg.updateReasons
            } as ChannelEventArgs<K>);
        }

        let _listener: (arg: any) => void = () => { };
        switch (event) {
            case "memberJoined":
            case "memberLeft":
                _listener = memberWrapper;
                break;
            case "memberUpdated":
                _listener = memberUpdatedWrapper;
                break;
            case "messageAdded":
            case "messageRemoved":
                _listener = messageWrapper;
                break;
            case "messageUpdated":
                _listener = messageUpdatedWrapper;
                break;
        }
        channel.on(event, _listener);

        return _listener as any;
    }

    async off(event: ChannelEventNames, listener: () => void) {
        if ("c" in this.channel) {
            this.channel.c.off(event, listener);
        }
    }
}
