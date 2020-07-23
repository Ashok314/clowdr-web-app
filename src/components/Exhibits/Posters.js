import React from 'react';
import {NavLink} from "react-router-dom";
import Parse from "parse";
import {Button, Card, message, Spin, Tooltip, Upload} from 'antd';
import {UploadOutlined} from '@ant-design/icons';
import {AuthUserContext} from "../Session";
import placeholder from './placeholder.png';
import ProgramPersonDisplay from "../Program/ProgramPersonDisplay";

class Exhibits extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            dirty: false,
            loading: true,
            posters: [],
            myposter: undefined,
            gotTracks: false,
            gotItems: false,
            gotPeople: false,
            gotSessions: false,
            gotRooms: false,
            waitForProgram: true,
            loggedIn: (this.props.auth.user ? true : false)
        }
        
    }

    changeChatPanel(posters) {
        if (posters.length > 0) {
            let sessions = posters.map(p => p.get("programSession"));
            let rooms = sessions.map(s => s ? s.get("room") : undefined);
            rooms = rooms.reduce((acc, r) => {
                if (r && !acc.find(rm => rm.id == r.id))
                    return [...acc, r]
                else
                    return acc
            }, []);
            if ((rooms.length == 1) && rooms[0].get("socialSpace")) {
                    //set the social space...
                    let ss = rooms[0].get("socialSpace");
                    this.props.auth.setSocialSpace(ss.get("name"));
                    this.props.auth.helpers.setGlobalState({forceChatOpen: true});
            }
            else {
                console.log("Warning: unexpected program layout")
                for(let room of rooms){
                    console.log(room.id + ", " + room.get("name"))
                }
                this.props.auth.setSocialSpace("Lobby");
            }
        }
    }
    componentWillUnmount() {
        this.props.auth.programCache.cancelSubscription("ProgramTrack", this);
        this.props.auth.setSocialSpace("Lobby");
    }

    getPosters(TRACK, items, tracks) {
        let posters = [];
        let track = tracks.find(t => t.get('name') == TRACK);
        if (track) {
            posters = items.filter(i => {
                return i.get("track") ? (i.get("track").id === track.id) : false
            });
            console.log(`[Posters]: number of posters in ${TRACK}: ${posters.length}`)
        }
        else
            console.log('[Posters]: track not found ' + TRACK);

        return posters;
    }

    getUserPoster(posters) {
        console.log(this.first_last)
        let myposter = posters.find(poster => {
            let authors = poster.get("authors");
            let me = authors.find(a => {
                let fl = a.get('name') ? a.get('name').split() : ["-", "-"];
                if (fl.length > 2) 
                    fl = [fl[0], fl[1]];
                return fl[0] === this.first_last[0] && fl[1] == this.first_last[1];
            });
            if (me) return true
            else return false
        });
        console.log(myposter)
        return myposter;
    }

    async componentDidMount() {
        //For social features, we need to wait for the login to complete before doing anything
        let user = undefined;
        if (!this.state.loggedIn) {
            user = await this.props.auth.refreshUser();
            if (user) {
                this.setState({
                    loggedIn: true
                }); 
            }
        }

        if (this.props.auth.user) {
            // Who am I? Very lightweight security
            this.first_last = this.props.auth.userProfile.get("displayName") ? this.props.auth.userProfile.get("displayName").split() : ["", ""];
            if (this.first_last.length > 2) {
                this.first_last = [this.first_last[0], this.first_last[1]]; // Just first and last names
            }
            this.initializePosters(this.props.match.params.track)
        }
    }

    async initializePosters(trackName) {

        this.setState({loading: true});
        let [track, posters] = await Promise.all(
            [
                this.props.auth.programCache.getProgramTrackByName(trackName),
                this.props.auth.programCache.getProgramItemsByTrackName(trackName,this)
            ]
        );


        this.setState({
            ProgramItems: posters,
            track: track,
            loading: false,
            myposter: this.getUserPoster(posters),
            waitForProgram: false
        });
        this.changeChatPanel(posters);
    }

    componentDidUpdate(prevProps) {
        if (prevProps.match.params.track != this.props.match.params.track) {
            this.initializePosters(this.props.match.params.track);
        }
    }

    onImageUpload(programItem, file) {
        // if (!this.state.myposter) {
        //     console.log("[Posters]: attempt to upload poster without poster id");
        //     return false;
        // }
        const isJpgOrPng = file.type === 'image/jpeg' || file.type === 'image/png';
        if (!isJpgOrPng) {
            message.error('You can only upload JPG/PNG file!');
            return false;
        }
        const isLt2M = file.size / 1024 / 1024 < 2;
        if (!isLt2M) {
            message.error('Image must be smaller than 2MB!');
            return false;
        }

        const reader = new FileReader();
        reader.onload = () => {
            const data = {
                content: reader.result,
                conferenceId: this.props.auth.currentConference.id,
                posterId: programItem.id
            };

            Parse.Cloud.run("poster-upload", data).then(async (res) => {
                message.info("Success! Your poster has been uploaded.");
                // this.state.myposter.set("image", reader.result);
                //ok lets just assume for now live query will work
                let updatedItemQ = new Parse.Query("ProgramItem");
                let updatedItem = await updatedItemQ.get(programItem.id);

                programItem.set("posterImage", updatedItem.get("posterImage")); //well that is gross
                console.log(res);
                this.setState({dirty: !this.state.dirty});
                console.log('[Posters]: Poster uploaded successfully');
            });
        }
        reader.readAsDataURL(file);
        return false;
    }

    onImageDownload() {
        console.log("[Posters]: onImageDownload");
    }

    render() {

        const { Meta } = Card;

        if (!this.state.loggedIn)
            return <div>You are not allowed to see this content. Please log in.</div>

        if (this.state.loading)
            return (
                <Spin tip="Loading...">
                </Spin>)

        let track = this.state.track;
        let trackName = track ? track.get("displayName") : this.props.match.params.track;

        if (this.props.match.params.style == "list") {

            return <div id="papers-list">
                    <h2>{trackName}</h2>
                    {this.state.posters.map((poster) => {
                        let authors = poster.get("authors");
                        let authorstr= authors.map(a => <ProgramPersonDisplay key={a.id} auth={this.props.auth} id={a.id} />).reduce((prev,curr) => [prev,", ",curr]);


                        return <p key={poster.id}>
                                <NavLink to={"/program/" + poster.get("confKey")}>
                                    <strong>{poster.get("title")}</strong> <i>{authorstr}</i>
                                </NavLink>
                                </p>
                    })}
                </div> 

        }

        return <div> 
            <h2>{trackName}</h2>
            <div className={"space-align-container"}>
                {this.state.ProgramItems.map((poster) => {
                    let authors = poster.get("authors");
                    let authorstr= authors.map(a => <ProgramPersonDisplay key={a.id} auth={this.props.auth} id={a.id} />).reduce((prev,curr) => [prev,", ",curr]);

                    let tool = "";
                    if (this.state.myposter && (this.state.myposter.id == poster.id))
                        tool = <span title="Looks like you're an author. Replace the image? Use 3x2 ratio.">
                                    <Upload accept=".png, .jpg" name='poster' beforeUpload={this.onImageUpload.bind(this, poster)}>
                                    <Button type="primary">
                                        <UploadOutlined />Upload
                                    </Button>
                                    </Upload>
                                </span>;

                    let img = placeholder;
                    if (poster.get("posterImage"))
                        img = poster.get("posterImage").url();

                    return <div className={"space-align-block"} key={poster.id} >
                                <NavLink to={"/program/" + poster.get("confKey")}>
                                    <Card hoverable style={{ width: 300 }} cover={<img alt="poster" style={{width:300, height:200 }} 
                                        src={img} 
                                    />}>
                                        <Tooltip mouseEnterDelay={0.5} placement="topLeft" title={poster.get("title")} arrowPointAtCenter>
                                            <Meta title={poster.get('title')} description={authorstr} />
                                        </Tooltip>
                                    </Card>
                                </NavLink>
                                {tool}
                            </div>
                })}
            </div> 
            </div>
    }
}

const PostersWithAuth = (props) => (
            <AuthUserContext.Consumer>
                {value => (
                    <Exhibits {...props} auth={value}  />
                )}
            </AuthUserContext.Consumer>
);

export default PostersWithAuth;

