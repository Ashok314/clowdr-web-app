import React, { useState } from 'react';
import clsx from 'clsx';
import { makeStyles, Theme } from '@material-ui/core/styles';
import { LocalAudioTrack, LocalVideoTrack, Participant, RemoteAudioTrack, RemoteVideoTrack } from 'twilio-video';

import AvatarIcon from '../../icons/AvatarIcon';
import Typography from '@material-ui/core/Typography';

import useIsTrackSwitchedOff from '../../hooks/useIsTrackSwitchedOff/useIsTrackSwitchedOff';
import usePublications from '../../hooks/usePublications/usePublications';
import useTrack from '../../hooks/useTrack/useTrack';
import useVideoContext from '../../hooks/useVideoContext/useVideoContext';
import useParticipantIsReconnecting from '../../hooks/useParticipantIsReconnecting/useParticipantIsReconnecting';
import AudioLevelIndicator from '../AudioLevelIndicator/AudioLevelIndicator';
import { UserProfile } from '@clowdr-app/clowdr-db-schema';
import useConference from '../../../../../hooks/useConference';
import useSafeAsync from '../../../../../hooks/useSafeAsync';
import useSelectedParticipant from '../VideoProvider/useSelectedParticipant/useSelectedParticipant';

const useStyles = makeStyles((theme: Theme) => ({
    container: {
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        cursor: 'pointer',
    },
    identity: {
        background: 'rgba(0, 0, 0, 0.5)',
        color: 'white',
        padding: '0.1em 0.3em 0.1em 0',
        fontSize: '1.2em',
        display: 'inline-flex',
        '& svg': {
            marginLeft: '0.3em',
        },
    },
    infoContainer: {
        position: 'absolute',
        zIndex: 2,
        height: '100%',
        width: '100%',
    },
    reconnectingContainer: {
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(40, 42, 43, 0.75)',
        zIndex: 1,
    },
    fullWidth: {
        gridArea: '1 / 1 / 2 / 3',
        [theme.breakpoints.down('sm')]: {
            gridArea: '1 / 1 / 3 / 3',
        },
    },
    avatarContainer: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'black',
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
        zIndex: 1,
        '& svg': {
            transform: 'scale(2)',
        },
    },
}));

interface MainParticipantInfoProps {
    participant: Participant;
    children: React.ReactNode;
}

export default function MainParticipantInfo({ participant, children }: MainParticipantInfoProps) {
    const classes = useStyles();
    const {
        room: { localParticipant },
    } = useVideoContext();
    const isLocal = localParticipant === participant;

    // const screenShareParticipant = useScreenShareParticipant();
    // const isRemoteParticipantScreenSharing = screenShareParticipant && screenShareParticipant !== localParticipant;

    const publications = usePublications(participant);
    const videoPublication = publications.find(p => p.trackName.includes('camera'));
    const screenSharePublication = publications.find(p => p.trackName.includes('screen'));
    const setSelectedParticipant = useSelectedParticipant()[1];

    const videoTrack = useTrack(screenSharePublication || videoPublication);
    const isVideoEnabled = Boolean(videoTrack);

    const audioPublication = publications.find(p => p.kind === 'audio');
    const audioTrack = useTrack(audioPublication) as LocalAudioTrack | RemoteAudioTrack | undefined;

    const isVideoSwitchedOff = useIsTrackSwitchedOff(videoTrack as LocalVideoTrack | RemoteVideoTrack);
    const isParticipantReconnecting = useParticipantIsReconnecting(participant);

    const conference = useConference();
    const [participantProfile, setParticipantProfile] = useState<UserProfile | null>(null);
    useSafeAsync(() => UserProfile.get(participant.identity, conference.id), setParticipantProfile, [participant.identity]);

    return (
        <div
            data-cy-main-participant
            data-cy-participant={participant.identity}
            className={clsx(classes.container, {
                [classes.fullWidth]: false,
            })}
            onClick={() => setSelectedParticipant(participant)}
        >
            <div className={classes.infoContainer}>
                <div className={classes.identity}>
                    <AudioLevelIndicator audioTrack={audioTrack} />
                    <Typography variant="body1" color="inherit">
                        {participantProfile ? participantProfile.displayName : ""}
                        {isLocal && ' (You)'}
                        {screenSharePublication && ' - Screen'}
                    </Typography>
                </div>
            </div>
            {(!isVideoEnabled || isVideoSwitchedOff) && (
                <div className={classes.avatarContainer}>
                    <AvatarIcon />
                </div>
            )}
            {isParticipantReconnecting && (
                <div className={classes.reconnectingContainer}>
                    <Typography variant="body1" style={{ color: 'white' }}>
                        Reconnecting...
          </Typography>
                </div>
            )}
            {children}
        </div>
    );
}