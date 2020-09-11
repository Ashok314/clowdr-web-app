import React, { useState } from 'react';
import { Button, Form, Input, Popconfirm, Space, Spin, Table, Alert } from "antd";
import Parse from "parse";
import {
    DeleteOutlined,
    EditOutlined,
    SaveTwoTone,
    CloseCircleTwoTone
} from '@ant-design/icons';
import { ClowdrState, EditableCellProps } from '../../../ClowdrTypes';
import { Store } from 'antd/lib/form/interface';
import { ConferenceConfiguration } from "../../../classes/ParseObjects";

interface ConfigurationProps {
    auth: ClowdrState,
}

interface ConfigurationState {
    loading: boolean,
    initialized: boolean,
    config: ConferenceConfiguration[],
    searched: boolean,
    alert: string | undefined,
    searchResult: ConferenceConfiguration[],
    visible: boolean
}

class Configuration extends React.Component<ConfigurationProps, ConfigurationState> {
    constructor(props: ConfigurationProps) {
        super(props);
        this.state = {
            loading: true,
            initialized: false,
            config: [],
            searched: false,
            alert: "",
            searchResult: [],
            visible: false
        };

    }

    componentDidMount() {
        // Has this conference been initialized?
        console.log('[Admin/Config]: active space ' + this.props.auth.activeSpace);
        if (this.props.auth.activeSpace && this.props.auth.activeSpace.chatChannel) {  //TS: activeSpace?
            this.setState({ initialized: true });
        }
        else
            console.log('[Admin/Config]: conference has not been yet initialized');

        this.refreshList();
    }

    componentDidUpdate(prevProps: any) {
    }

    async refreshList() {
        let query = new Parse.Query<ConferenceConfiguration>("ConferenceConfiguration");
        query.equalTo("conference", this.props.auth.currentConference);
        let res = await query.find();
        console.log('[Admin/Config]: Found ' + res.length + ' vars');
        this.setState({
            config: res,
            loading: false
        });
    }

    componentWillUnmount() {
    }

    initConference() {
        if (!this.props.auth.currentConference) {
            throw new Error("Cannot init conference: current conference is null!");
        }

        let currentConferenceId = this.props.auth.currentConference.id;
        const data = { conference: currentConferenceId };
        Parse.Cloud.run("init-conference-2", data).then(response => {
            // Note: By this point, props may have change and so we cannot rely
            // on `this.props.auth.currentConference.id` to provide the ID.
            console.log('[Admin/Config]: successfully initialized conference ' + currentConferenceId);
            this.setState({ initialized: true });
        }).catch(err => console.log('[Admin/Config]: error in initializing conference: ' + err));
    }

    render() {
        // Set up editable table cell
        const EditableCell: React.FC<EditableCellProps<ConferenceConfiguration>> = ({
            editing,
            dataIndex,
            title,
            inputType,
            record,
            index,
            children,
            ...restProps
        }) => {
            let inputNode = null;
            switch (dataIndex) {
                case ('key'):
                    inputNode = <Input />;
                    break;
                case ('value'):
                    inputNode = <Input />;
                    break;
                default:
                    inputNode = null;
                    break;
            }

            return (
                <td {...restProps}>
                    {editing ? (
                        <Form.Item
                            name={dataIndex}
                            style={{
                                margin: 0,
                            }}
                            rules={[
                                {
                                    required: true,
                                    message: `Please Input ${title}!`,
                                },
                            ]}
                        >
                            {inputNode}
                        </Form.Item>
                    ) : (
                            children
                        )}
                </td>
            );
        };

        //Set up editable table
        const EditableTable = () => {
            const [form] = Form.useForm();
            const [data, setData] = useState(this.state.config);
            const [editingKey, setEditingKey] = useState('');
            const isEditing = (record: ConferenceConfiguration) => record.id === editingKey;

            const edit = (record: ConferenceConfiguration) => {
                form.setFieldsValue({
                    key: record.key ? record.key : "",
                    value: record.value ? record.value : ""
                });
                setEditingKey(record.id)
            }

            const cancel = () => {
                setEditingKey('');
            };

            const onDelete = (record: ConferenceConfiguration) => {
                const newConfigList = [...this.state.config];
                // delete from database
                record.destroy().then(() => {
                    this.setState({
                        alert: "delete success",
                        config: newConfigList.filter(config => config.id !== record.id)
                    });
                    console.log("Config deleted from db")
                }).catch(error => {
                    this.setState({ alert: "delete error" });
                    console.log("[Admin/Config]: item cannot be deleted from db");
                })
                    ;
            };

            const save = async (id: string) => {
                console.log("Entering save func");
                try {
                    const row: Store = await form.validateFields();
                    const newData = [...data];
                    let config = newData.find(config => config.id === id);

                    if (config) {
                        config.set("key", row.key);
                        config.set("value", row.value);
                        setData(newData);
                        config.save()
                            .then((response) => {
                                console.log('[Admin/Config]: Updated config', response);
                                this.setState({ alert: "save success" });
                            })
                            .catch(err => {
                                console.log('[Admin/Config]: error when saving config: ' + err);
                                if (config) {
                                    console.log("@" + config.id);
                                }
                                this.setState({ alert: "save error" });
                            });
                        setEditingKey('');
                    }
                    else {
                        // TODO: This is completely unsafe - this will result in errors,
                        // the logic around adding items needs fixing here. We should create
                        // but not commit the new configuration, rather than storing the form
                        // data directly
                        // @ts-ignore
                        newData.push(row);
                        setData(newData);
                        setEditingKey('');
                    }
                } catch (errInfo) {
                    console.log('[Admin/Config]: Validate Failed:', errInfo);
                }
            };

            const columns = [
                {
                    title: 'Key',
                    dataIndex: 'key',
                    key: 'key',
                    editable: true,
                    width: '50%',
                    sorter: (a: ConferenceConfiguration, b: ConferenceConfiguration) => {
                        var nameA = a.key ? a.key : "";
                        var nameB = b.key ? b.key : "";
                        return nameA.localeCompare(nameB);
                    },
                    render: (_: string, record: ConferenceConfiguration) => <span>{record.key}</span>,
                },
                {
                    title: 'Value',
                    dataIndex: 'value',
                    editable: true,
                    width: '50%',
                    sorter: (a: ConferenceConfiguration, b: ConferenceConfiguration) => {
                        var valueA = a.value ? a.value : "";
                        var valueB = b.value ? b.value : "";
                        return valueA.localeCompare(valueB);
                    },
                    render: (_: string, record: ConferenceConfiguration) => <span>{record.value}</span>,
                    key: 'value',
                },
                {
                    title: 'Action',
                    dataIndex: 'action',
                    render: (_: string, record: ConferenceConfiguration) => {
                        const editable = isEditing(record);
                        if (this.state.config.length > 0) {
                            return editable ? (
                                <span>
                                    <a
                                        onClick={() => save(record.id)}
                                        style={{
                                            marginRight: 8,
                                        }}
                                    >
                                        {<SaveTwoTone />}
                                    </a>
                                    <Popconfirm title="Sure to cancel?" onConfirm={cancel}>
                                        <a>{<CloseCircleTwoTone />}</a>
                                    </Popconfirm>
                                </span>
                            ) : (
                                    <Space size='small'>
                                        <a title="Edit" onClick={() => { if (editingKey === '') edit(record) }}>
                                            {/* <a title="Edit" disabled={editingKey !== ''} onClick={() => edit(record)}> */}
                                            {<EditOutlined />}
                                        </a>
                                        <Popconfirm
                                            title="Are you sure delete this variable?"
                                            onConfirm={() => onDelete(record)}
                                            okText="Yes"
                                            cancelText="No"
                                        >
                                            <a title="Delete">{<DeleteOutlined />}</a>
                                        </Popconfirm>
                                    </Space>

                                );
                        } else {
                            return null;
                        }
                    },
                },
            ];

            const mergedColumns = columns.map(col => {
                if (!col.editable) {
                    return col;
                }
                return {
                    ...col,
                    onCell: (record: ConferenceConfiguration) => ({
                        record,
                        inputType: 'text',
                        dataIndex: col.dataIndex,
                        title: col.title,
                        editing: isEditing(record),
                    }),
                };
            });

            return (
                <Form form={form} component={false}>
                    <Table
                        components={{
                            body: {
                                cell: EditableCell,
                            },
                        }}
                        bordered
                        dataSource={this.state.searched ? this.state.searchResult : this.state.config}
                        columns={mergedColumns}
                        rowClassName="editable-row"
                        pagination={false}
                    />
                </Form>
            );
        };

        const newConfig = () => {
            if (!this.props.auth.currentConference) {
                throw new Error("Cannot generate new conference config: current conference is null!");
            }

            const config = new ConferenceConfiguration();
            config.set("key", "Please enter a name");
            config.set("value", "Please enter a value");

            let acl = new Parse.ACL();
            acl.setPublicWriteAccess(false);
            acl.setPublicReadAccess(false);
            acl.setRoleWriteAccess(this.props.auth.currentConference.id + "-admin", true);
            acl.setRoleReadAccess(this.props.auth.currentConference.id + "-admin", true);
            config.setACL(acl);
            config.set("conference", this.props.auth.currentConference);
            config.save().then((val: any) => { //TS: what is val? Maybe we need a new configuration schema
                config.set("key", val.id);
                this.setState({ alert: "add success", config: [config, ...this.state.config] })
            }).catch((err: Error) => {
                this.setState({ alert: "add error" });
                console.log('[Admin/Config]: error: ' + err);
            });
        }

        if (this.state.loading) // TS: Should this be state.loading or props.loading?
            return (
                <Spin tip="Loading...">
                </Spin>)

        let redButton = <td>&nbsp;</td>;
        if (!this.state.initialized)
            redButton = <td style={{ textAlign: "right" }}><Button
                style={{ background: "red", borderColor: "yellow" }}
                type="primary"
                onClick={this.initConference.bind(this)}
            >
                Initialize Conference
            </Button></td>

        return <div><table style={{ width: "100%" }}><tbody><tr>
            <td><Button
                type="primary"
                onClick={newConfig}
            >
                New config variable
            </Button>
                {this.state.alert ? <Alert
                    onClose={() => this.setState({ alert: undefined })}
                    style={{
                        margin: 16,
                        display: "inline-block",
                    }}
                    message={this.state.alert}
                    type={this.state.alert.includes("success") ? "success" : "error"}
                    showIcon
                    closable
                /> : <span> </span>}</td>
            {redButton}
        </tr></tbody></table>
            <Input.Search
                allowClear
                onSearch={key => {
                    if (key === "") {
                        this.setState({ searched: false });
                    }
                    else {
                        this.setState({ searched: true });
                        this.setState({
                            searchResult: this.state.config.filter(
                                config =>
                                    (config.key && config.key.toLowerCase().includes(key.toLowerCase()))
                                    || (config.value && config.value.toLowerCase().includes(key.toLowerCase())))
                        })
                    }
                }
                }
            />
            <EditableTable />
        </div>
    }
}

export default Configuration;
