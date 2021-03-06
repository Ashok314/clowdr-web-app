import React from 'react';
import { Link } from 'react-router-dom';
import "./Notification.scss";

interface Props {
    content: string | JSX.Element,
    action?: { url: string, text: string }
}

/**
 * React component for a simple toast notification with a link.
 */
export default function Notification(props: Props) {
    return <div>
        {typeof props.content === "string" ? <p>{props.content}</p> : props.content}
        {props.action
            ? <p className="notification-action">
                <Link to={props.action.url}>
                    {props.action.text}
                    <i className="fas fa-chevron-circle-right icon"></i>
                </Link>
            </p>
            : <></>}
    </div>;
}
